const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');
require('dotenv').config();
const mongoose = require('mongoose');
const AppState = require('./models/AppState');
const Session = require('./models/Session');

function resolvePortFromEnv() {
  const rawPort = String(process.env.PORT || '').trim();
  if (!rawPort) return 3000;

  const parsed = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(`PORT inválida (${rawPort}). Usando fallback 3000.`);
    return 3000;
  }

  return parsed;
}

const PORT = resolvePortFromEnv();
const PUBLIC_ROOT = path.join(__dirname, 'public');
const MONGO_URI = String(process.env.MONGO_URI || '').trim();
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const USE_SECURE_COOKIES = IS_PRODUCTION ? true : process.env.USE_SECURE_COOKIES === 'true';
const CORS_ALLOWED_ORIGIN = String(process.env.CORS_ALLOWED_ORIGIN || '').trim();
const SESSION_COOKIE_NAME = 'futpass_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const INVENTORY_MOVEMENTS_LIMIT = 2000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_API_REQUESTS_PER_WINDOW = Number.parseInt(process.env.RATE_LIMIT_MAX_API || '', 10) || 600;
const MAX_AUTH_REQUESTS_PER_WINDOW = Number.parseInt(process.env.RATE_LIMIT_MAX_AUTH || '', 10) || 80;
const MAX_FAILED_LOGINS = Number.parseInt(process.env.MAX_FAILED_LOGINS || '', 10) || 5;
const FAILED_LOGIN_BLOCK_WINDOW_MS = Number.parseInt(process.env.FAILED_LOGIN_WINDOW_MS || '', 10) || (15 * 60 * 1000);
const ENFORCE_ORIGIN_ON_STATE_CHANGES = IS_PRODUCTION || String(process.env.ENFORCE_ORIGIN_ON_STATE_CHANGES || '').trim() === 'true';
const sessions = new Map();
const requestRateLimits = new Map();
const DEFAULT_DB_STATE = { alunos: [], config: {}, users: [], accessLogs: [] };
let dbCache = JSON.parse(JSON.stringify(DEFAULT_DB_STATE));
let dbPersistChain = Promise.resolve();
let sessionPersistChain = Promise.resolve();
let hasWarnedInsecureTransport = false;
let hasWarnedMissingCorsOrigin = false;
const ALLOWED_STATIC_EXTENSIONS = new Set(['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.ico']);
// tracking de tentativas de login para proteção simples contra brute-force
const failedLogins = new Map(); // chave: 'ip:...' ou 'user:...'
const DEV_TRUSTED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
]);

const PROTECTED_PAGES = new Set(['/alunos.html', '/cadastro.html', '/financeiro.html', '/uniformes.html', '/users.html']);
const ADMIN_ONLY_PAGES = new Set(['/users.html']);

function getTrustedOriginsFromEnv() {
  const rawOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '').trim();
  const singleOrigin = String(CORS_ALLOWED_ORIGIN || '').trim();
  const values = [];

  if (singleOrigin) values.push(singleOrigin);
  if (rawOrigins) {
    rawOrigins
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
      .forEach(item => values.push(item));
  }

  return new Set(values);
}

const TRUSTED_ORIGINS = getTrustedOriginsFromEnv();

function getDefaultInventory() {
  return {
    uniformeCompleto: { nome: 'Uniforme completo', valor: 130, tamanhos: { P: 23, M: 33, G: 28, GG: 20 } },
    camiseta: { nome: 'Camiseta', valor: 0, tamanhos: { P: 23, M: 33, G: 28, GG: 20 } },
    calcao: { nome: 'Calção', valor: 0, tamanhos: { P: 0, M: 0, G: 0, GG: 0 } },
    meiao: { nome: 'Meião', valor: 0, tamanhos: { P: 0, M: 0, G: 0, GG: 0 } },
    caneleira: { nome: 'Caneleira', valor: 0, tamanhos: { P: 0, M: 0, G: 0, GG: 0 } },
  };
}

function ensureInventoryConfig(db) {
  db.config = db.config && typeof db.config === 'object' ? db.config : {};
  const defaults = getDefaultInventory();
  const current = db.config.estoque && typeof db.config.estoque === 'object' ? db.config.estoque : {};
  const merged = {};

  for (const [key, item] of Object.entries(defaults)) {
    const currentItem = current[key] && typeof current[key] === 'object' ? current[key] : {};
    const currentSizes = currentItem.tamanhos && typeof currentItem.tamanhos === 'object' ? currentItem.tamanhos : {};
    merged[key] = {
      nome: currentItem.nome || item.nome,
      valor: Math.max(0, Number(currentItem.valor ?? item.valor) || 0),
      tamanhos: {
        P: Number(currentSizes.P ?? item.tamanhos.P) || 0,
        M: Number(currentSizes.M ?? item.tamanhos.M) || 0,
        G: Number(currentSizes.G ?? item.tamanhos.G) || 0,
        GG: Number(currentSizes.GG ?? item.tamanhos.GG) || 0,
      },
    };
  }

  db.config.estoque = merged;
  return merged;
}

function ensureInventoryMovementsConfig(db) {
  db.config = db.config && typeof db.config === 'object' ? db.config : {};
  db.config.estoqueMovimentacoes = Array.isArray(db.config.estoqueMovimentacoes) ? db.config.estoqueMovimentacoes : [];
  return db.config.estoqueMovimentacoes;
}

function ensureReportsConfig(db) {
  db.config = db.config && typeof db.config === 'object' ? db.config : {};
  db.config.relatorios = Array.isArray(db.config.relatorios) ? db.config.relatorios : [];
  return db.config.relatorios;
}

function parseStoredDate(value) {
  if (!value) return null;
  const raw = String(value);
  const date = raw.includes('T') ? new Date(raw) : new Date(`${raw}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getMonthLabel(monthIndex) {
  return ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'][monthIndex] || '';
}

function getMonthKey(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function formatCurrencyBRL(value) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateTimeBR(value) {
  const date = parseStoredDate(value);
  if (!date) return 'Nao informado';
  return date.toLocaleString('pt-BR', { timeZone: 'UTC' });
}

function formatDateBR(value) {
  const date = parseStoredDate(value);
  if (!date) return 'Nao informado';
  return date.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

function getMovementTypeLabel(type) {
  const labels = {
    venda: 'Venda',
    'estorno-venda': 'Estorno de venda',
    'entrada-manual': 'Entrada manual',
    'ajuste-manual': 'Ajuste manual',
    'correcao-manual': 'Correcao manual',
    'preco-atualizado': 'Preco atualizado',
  };
  return labels[String(type || '')] || 'Movimentacao';
}

function sanitizeInventoryMovementContext(rawContext) {
  const context = rawContext && typeof rawContext === 'object' ? rawContext : {};
  return {
    tipo: String(context.tipo || 'ajuste-manual').trim() || 'ajuste-manual',
    origem: String(context.origem || 'manual').trim() || 'manual',
    motivo: String(context.motivo || '').trim(),
    observacao: String(context.observacao || '').trim(),
    referencia: String(context.referencia || '').trim(),
    alunoId: context.alunoId ? String(context.alunoId).trim() : null,
    alunoNome: context.alunoNome ? String(context.alunoNome).trim() : null,
  };
}

function createInventoryMovement(db, auth, payload) {
  const movements = ensureInventoryMovementsConfig(db);
  const user = auth && auth.user ? auth.user : null;
  movements.unshift({
    id: 'MOV-' + Math.floor(Math.random() * 1000000000),
    data: new Date().toISOString(),
    tipo: payload.tipo,
    tipoLabel: getMovementTypeLabel(payload.tipo),
    origem: payload.origem || 'manual',
    motivo: payload.motivo || '',
    observacao: payload.observacao || '',
    referencia: payload.referencia || '',
    itemCodigo: payload.itemCodigo || '',
    itemNome: payload.itemNome || payload.itemCodigo || 'Item',
    tamanho: payload.tamanho || null,
    quantidadeDelta: Number(payload.quantidadeDelta) || 0,
    quantidadeAnterior: Number(payload.quantidadeAnterior) || 0,
    quantidadeAtual: Number(payload.quantidadeAtual) || 0,
    valorUnitarioAnterior: Number(payload.valorUnitarioAnterior) || 0,
    valorUnitarioAtual: Number(payload.valorUnitarioAtual) || 0,
    alunoId: payload.alunoId || null,
    alunoNome: payload.alunoNome || null,
    userId: user ? user.id : null,
    username: user ? user.username : null,
    userNome: user ? user.nome : null,
  });
  db.config.estoqueMovimentacoes = movements.slice(0, INVENTORY_MOVEMENTS_LIMIT);
}

function registerInventorySnapshotChanges(db, previousInventory, nextInventory, auth, rawContext) {
  const context = sanitizeInventoryMovementContext(rawContext);
  const itemKeys = new Set([...Object.keys(previousInventory || {}), ...Object.keys(nextInventory || {})]);

  itemKeys.forEach(itemCodigo => {
    const previousItem = previousInventory[itemCodigo] || { nome: itemCodigo, valor: 0, tamanhos: {} };
    const nextItem = nextInventory[itemCodigo] || { nome: itemCodigo, valor: 0, tamanhos: {} };
    const itemName = nextItem.nome || previousItem.nome || itemCodigo;
    const previousPrice = Math.max(0, Number(previousItem.valor) || 0);
    const nextPrice = Math.max(0, Number(nextItem.valor) || 0);

    if (previousPrice !== nextPrice) {
      createInventoryMovement(db, auth, {
        ...context,
        tipo: 'preco-atualizado',
        itemCodigo,
        itemNome: itemName,
        quantidadeDelta: 0,
        quantidadeAnterior: 0,
        quantidadeAtual: 0,
        valorUnitarioAnterior: previousPrice,
        valorUnitarioAtual: nextPrice,
      });
    }

    ['P', 'M', 'G', 'GG'].forEach(size => {
      const previousQuantity = Math.max(0, Number(previousItem.tamanhos?.[size]) || 0);
      const nextQuantity = Math.max(0, Number(nextItem.tamanhos?.[size]) || 0);
      const delta = nextQuantity - previousQuantity;

      if (delta === 0) return;

      createInventoryMovement(db, auth, {
        ...context,
        itemCodigo,
        itemNome: itemName,
        tamanho: size,
        quantidadeDelta: delta,
        quantidadeAnterior: previousQuantity,
        quantidadeAtual: nextQuantity,
        valorUnitarioAnterior: previousPrice,
        valorUnitarioAtual: nextPrice,
      });
    });
  });
}

function getPlanValue(planoEscolhido) {
  const plano = String(planoEscolhido || '').toLowerCase();
  const match = plano.match(/r\$\s*([\d.,]+)/i);

  if (match && match[1]) {
    const normalizado = match[1].replace(/\./g, '').replace(',', '.');
    const valor = Number(normalizado);
    if (!Number.isNaN(valor) && valor > 0) return valor;
  }

  if (plano.includes('3 vezes')) return 170;
  if (plano.includes('2 vezes')) return 150;
  if (plano.includes('1 vez')) return 130;
  return 130;
}

function getStudentMonthlyValue(aluno) {
  const manualValue = Number(aluno?.mensalidadeValor);
  if (Number.isFinite(manualValue) && manualValue >= 0) return manualValue;
  return getPlanValue(aluno?.planoEscolhido);
}

function isStudentChargeableInMonth(aluno, year, monthIndex) {
  const start = parseStoredDate(aluno.dataInicioPagamento);
  if (!start) return false;

  const monthStart = new Date(Date.UTC(year, monthIndex, 1, 12, 0, 0));
  const startMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1, 12, 0, 0));
  if (monthStart < startMonth) return false;

  const cancelDate = parseStoredDate(aluno.dataCancelamento);
  if (cancelDate) {
    const cancelMonth = new Date(Date.UTC(cancelDate.getUTCFullYear(), cancelDate.getUTCMonth(), 1, 12, 0, 0));
    if (cancelMonth < monthStart) return false;
  }

  return true;
}

function isMonthPaidByLastPayment(aluno, year, monthIndex) {
  const lastPayment = parseStoredDate(aluno.dataUltimoPagamento);
  if (!lastPayment) return false;
  return (
    lastPayment.getUTCFullYear() > year ||
    (lastPayment.getUTCFullYear() === year && lastPayment.getUTCMonth() >= monthIndex)
  );
}

function getMonthDueDate(aluno, year, monthIndex) {
  const start = parseStoredDate(aluno.dataInicioPagamento);
  if (!start) return null;
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const dueDay = Math.min(start.getUTCDate(), lastDay);
  return new Date(Date.UTC(year, monthIndex, dueDay, 23, 59, 59));
}

function getMonthlyChargeEntry(aluno, year, monthIndex) {
  if (!isStudentChargeableInMonth(aluno, year, monthIndex)) return null;

  const value = getStudentMonthlyValue(aluno);
  const paid = isMonthPaidByLastPayment(aluno, year, monthIndex);
  const dueDate = getMonthDueDate(aluno, year, monthIndex);
  const now = new Date();
  const closedMonth = new Date(Date.UTC(year, monthIndex + 1, 1)) <= now;
  const status = paid ? 'Pago' : (closedMonth ? 'Devedor' : 'Pendente');

  return {
    alunoId: aluno.id,
    alunoNome: aluno.nome || 'Aluno sem nome',
    responsavel: aluno.respNome || 'Responsável não informado',
    plano: aluno.planoEscolhido || 'Plano não informado',
    valor: value,
    formaPagamento: aluno.formaPagamento || 'Não informado',
    status,
    vencimento: dueDate ? dueDate.toISOString() : null,
    ultimoPagamento: aluno.dataUltimoPagamento || null,
    statusMatricula: aluno.statusMatricula || 'Ativo',
  };
}

function getNormalizedSalesForAluno(aluno) {
  const history = Array.isArray(aluno.uniformeHistorico) ? aluno.uniformeHistorico : [];
  const sales = Array.isArray(aluno.vendasAvulsas) ? aluno.vendasAvulsas : [];

  const normalizedHistory = history.map(item => ({
    data: item.data,
    ciclo: item.ciclo,
    valor: Number(item.valor) || 130,
    tipo: 'Uniforme completo',
    categoria: 'uniforme',
    tamanho: item.tamanho || 'Não informado',
    formaPagamento: item.formaPagamento || aluno.formaPagamento || 'Não informado',
    itemCodigo: 'uniformeCompleto',
    alunoId: aluno.id,
    alunoNome: aluno.nome || 'Aluno sem nome',
  }));

  const normalizedSales = sales.map(item => ({
    data: item.data,
    ciclo: item.ciclo,
    valor: Number(item.valor) || 0,
    tipo: item.tipo || 'Produto avulso',
    categoria: item.categoria || 'produto-avulso',
    tamanho: item.tamanho || 'Não informado',
    formaPagamento: item.formaPagamento || 'Não informado',
    itemCodigo: item.itemCodigo || '',
    alunoId: aluno.id,
    alunoNome: aluno.nome || 'Aluno sem nome',
  }));

  return [...normalizedHistory, ...normalizedSales].filter(item => parseStoredDate(item.data));
}

function getSalesForMonth(db, year, monthIndex) {
  return db.alunos
    .flatMap(getNormalizedSalesForAluno)
    .filter(item => {
      const saleDate = parseStoredDate(item.data);
      return saleDate && saleDate.getUTCFullYear() === year && saleDate.getUTCMonth() === monthIndex;
    })
    .sort((a, b) => parseStoredDate(a.data) - parseStoredDate(b.data));
}

function summarizeMonthlyCharges(mensalidades) {
  const statusMap = new Map();
  const paymentMap = new Map();

  mensalidades.forEach(item => {
    const status = item.status || 'Nao informado';
    const payment = item.formaPagamento || 'Nao informado';
    const value = Number(item.valor) || 0;

    const currentStatus = statusMap.get(status) || { status, quantidade: 0, total: 0 };
    currentStatus.quantidade += 1;
    currentStatus.total += value;
    statusMap.set(status, currentStatus);

    const currentPayment = paymentMap.get(payment) || { formaPagamento: payment, quantidade: 0, total: 0 };
    currentPayment.quantidade += 1;
    currentPayment.total += value;
    paymentMap.set(payment, currentPayment);
  });

  return {
    porStatus: Array.from(statusMap.values()).sort((a, b) => b.total - a.total),
    porFormaPagamento: Array.from(paymentMap.values()).sort((a, b) => b.total - a.total),
  };
}

function summarizeRevenueByPayment(mensalidadesPagas, vendas) {
  const map = new Map();

  [...mensalidadesPagas.map(item => ({ ...item, origem: 'mensalidade' })), ...vendas.map(item => ({ ...item, origem: item.categoria === 'uniforme' ? 'uniforme' : 'produto-avulso' }))]
    .forEach(item => {
      const payment = item.formaPagamento || 'Nao informado';
      const value = Number(item.valor) || 0;
      const current = map.get(payment) || {
        formaPagamento: payment,
        mensalidades: 0,
        vendasUniforme: 0,
        vendasProdutos: 0,
        total: 0,
      };

      if (item.origem === 'mensalidade') current.mensalidades += value;
      else if (item.origem === 'uniforme') current.vendasUniforme += value;
      else current.vendasProdutos += value;
      current.total += value;
      map.set(payment, current);
    });

  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

function summarizeSalesByItem(vendas) {
  const map = new Map();

  vendas.forEach(item => {
    const key = item.itemCodigo || `${item.tipo || 'item'}:${item.categoria || 'categoria'}`;
    const current = map.get(key) || {
      itemCodigo: item.itemCodigo || '',
      nome: item.tipo || 'Item nao informado',
      categoria: item.categoria || 'produto-avulso',
      quantidade: 0,
      totalVendido: 0,
      tamanhos: {},
      vendas: [],
    };

    const tamanho = item.tamanho || 'Nao informado';
    current.quantidade += 1;
    current.totalVendido += Number(item.valor) || 0;
    current.tamanhos[tamanho] = (current.tamanhos[tamanho] || 0) + 1;
    current.vendas.push({
      data: item.data || null,
      alunoId: item.alunoId || null,
      alunoNome: item.alunoNome || 'Aluno sem nome',
      tamanho,
      valor: Number(item.valor) || 0,
      formaPagamento: item.formaPagamento || 'Nao informado',
    });
    map.set(key, current);
  });

  return Array.from(map.values())
    .map(item => ({
      ...item,
      vendas: item.vendas.sort((a, b) => String(a.data || '').localeCompare(String(b.data || ''))),
    }))
    .sort((a, b) => b.totalVendido - a.totalVendido);
}

function getInventoryPositionSnapshot(db) {
  const inventory = ensureInventoryConfig(db);

  return Object.entries(inventory)
    .map(([itemCodigo, item]) => {
      const tamanhos = item.tamanhos && typeof item.tamanhos === 'object' ? item.tamanhos : {};
      const saldoPorTamanho = {
        P: Number(tamanhos.P) || 0,
        M: Number(tamanhos.M) || 0,
        G: Number(tamanhos.G) || 0,
        GG: Number(tamanhos.GG) || 0,
      };
      const quantidadeTotal = Object.values(saldoPorTamanho).reduce((sum, qty) => sum + qty, 0);
      const valorUnitario = Math.max(0, Number(item.valor) || 0);

      return {
        itemCodigo,
        nome: item.nome || itemCodigo,
        valorUnitario,
        quantidadeTotal,
        saldoPorTamanho,
        valorTotalEstimado: valorUnitario * quantidadeTotal,
        estoqueBaixo: quantidadeTotal <= 3,
      };
    })
    .sort((a, b) => b.valorTotalEstimado - a.valorTotalEstimado);
}

function getInventoryMovementsForMonth(db, year, monthIndex) {
  return ensureInventoryMovementsConfig(db)
    .filter(item => {
      const movementDate = parseStoredDate(item.data);
      return movementDate && movementDate.getUTCFullYear() === year && movementDate.getUTCMonth() === monthIndex;
    })
    .sort((a, b) => String(a.data || '').localeCompare(String(b.data || '')));
}

function summarizeInventoryMovements(movements) {
  const typeMap = new Map();
  const itemMap = new Map();

  movements.forEach(item => {
    const movementType = item.tipo || 'ajuste-manual';
    const typeEntry = typeMap.get(movementType) || {
      tipo: movementType,
      tipoLabel: item.tipoLabel || getMovementTypeLabel(movementType),
      quantidadeMovimentos: 0,
      saldoDelta: 0,
    };
    typeEntry.quantidadeMovimentos += 1;
    typeEntry.saldoDelta += Number(item.quantidadeDelta) || 0;
    typeMap.set(movementType, typeEntry);

    const itemKey = item.itemCodigo || item.itemNome || 'item';
    const itemEntry = itemMap.get(itemKey) || {
      itemCodigo: item.itemCodigo || '',
      itemNome: item.itemNome || 'Item',
      quantidadeMovimentos: 0,
      saldoDelta: 0,
    };
    itemEntry.quantidadeMovimentos += 1;
    itemEntry.saldoDelta += Number(item.quantidadeDelta) || 0;
    itemMap.set(itemKey, itemEntry);
  });

  return {
    porTipo: Array.from(typeMap.values()).sort((a, b) => Math.abs(b.saldoDelta) - Math.abs(a.saldoDelta)),
    porItem: Array.from(itemMap.values()).sort((a, b) => Math.abs(b.saldoDelta) - Math.abs(a.saldoDelta)),
  };
}

function buildMonthlyAccountantTextReport(report) {
  const lines = [];
  const revenueByPayment = Array.isArray(report?.contador?.receitaPorFormaPagamento) ? report.contador.receitaPorFormaPagamento : [];
  const monthlyByStatus = Array.isArray(report?.mensalidadesResumo?.porStatus) ? report.mensalidadesResumo.porStatus : [];
  const stockSales = Array.isArray(report?.estoque?.saidasNoMes) ? report.estoque.saidasNoMes : [];
  const stockPosition = Array.isArray(report?.estoque?.posicaoAtualNaGeracao) ? report.estoque.posicaoAtualNaGeracao : [];
  const stockMovements = Array.isArray(report?.estoque?.movimentacoesNoMes) ? report.estoque.movimentacoesNoMes : [];
  const overdue = Array.isArray(report?.inadimplentes) ? report.inadimplentes : [];

  lines.push('FUTPASS - RELATORIO MENSAL DETALHADO PARA CONTADOR');
  lines.push(`Competencia: ${report.competencia}`);
  lines.push(`Referencia: ${report.referencia}`);
  lines.push(`Gerado em: ${formatDateTimeBR(report.geradoEm)}`);
  lines.push('');

  lines.push('RESUMO FINANCEIRO');
  lines.push(`Mensalidades recebidas: ${formatCurrencyBRL(report.resumo.mensalidadesRecebidas)}`);
  lines.push(`Mensalidades em aberto: ${formatCurrencyBRL(report.resumo.mensalidadesEmAberto)}`);
  lines.push(`Vendas de uniforme: ${formatCurrencyBRL(report.resumo.vendasUniforme)}`);
  lines.push(`Vendas de produtos: ${formatCurrencyBRL(report.resumo.vendasProdutos)}`);
  lines.push(`Receita total do mes: ${formatCurrencyBRL(report.resumo.receitaTotal)}`);
  lines.push(`Valor estimado do estoque atual: ${formatCurrencyBRL(report.resumo.valorEstoqueAtualEstimado)}`);
  lines.push('');

  lines.push('RECEITA POR FORMA DE PAGAMENTO');
  if (!revenueByPayment.length) {
    lines.push('Sem recebimentos registrados neste mes.');
  } else {
    revenueByPayment.forEach(item => {
      lines.push(`${item.formaPagamento}: total ${formatCurrencyBRL(item.total)} | mensalidades ${formatCurrencyBRL(item.mensalidades)} | uniformes ${formatCurrencyBRL(item.vendasUniforme)} | produtos ${formatCurrencyBRL(item.vendasProdutos)}`);
    });
  }
  lines.push('');

  lines.push('MENSALIDADES POR STATUS');
  if (!monthlyByStatus.length) {
    lines.push('Nenhuma mensalidade encontrada para a competencia.');
  } else {
    monthlyByStatus.forEach(item => {
      lines.push(`${item.status}: ${item.quantidade} aluno(s) | ${formatCurrencyBRL(item.total)}`);
    });
  }
  lines.push('');

  lines.push('DETALHAMENTO DE MENSALIDADES');
  if (!Array.isArray(report.mensalidades) || !report.mensalidades.length) {
    lines.push('Nenhuma mensalidade detalhada no periodo.');
  } else {
    report.mensalidades.forEach(item => {
      lines.push(`- ${item.alunoNome} | Responsavel: ${item.responsavel} | Plano: ${item.plano} | Status: ${item.status} | Forma: ${item.formaPagamento} | Valor: ${formatCurrencyBRL(item.valor)} | Vencimento: ${formatDateBR(item.vencimento)} | Ultimo pagamento: ${formatDateBR(item.ultimoPagamento)}`);
    });
  }
  lines.push('');

  lines.push('SAIDAS DE ESTOQUE NO MES');
  if (!stockSales.length) {
    lines.push('Nenhuma saida de estoque por venda foi registrada neste mes.');
  } else {
    stockSales.forEach(item => {
      const tamanhos = Object.entries(item.tamanhos || {}).map(([size, qty]) => `${size}:${qty}`).join(' | ');
      lines.push(`${item.nome} (${item.categoria}) | Qtd: ${item.quantidade} | Total vendido: ${formatCurrencyBRL(item.totalVendido)}${tamanhos ? ` | Tamanhos: ${tamanhos}` : ''}`);
      item.vendas.forEach(venda => {
        lines.push(`  - ${formatDateBR(venda.data)} | ${venda.alunoNome} | Tam: ${venda.tamanho} | ${venda.formaPagamento} | ${formatCurrencyBRL(venda.valor)}`);
      });
    });
  }
  lines.push('');

  lines.push('MOVIMENTACOES DE ESTOQUE NO MES');
  if (!stockMovements.length) {
    lines.push('Nenhuma movimentacao manual ou automatica de estoque foi registrada neste mes.');
  } else {
    stockMovements.forEach(item => {
      const deltaLabel = `${item.quantidadeDelta > 0 ? '+' : ''}${item.quantidadeDelta}`;
      const sizeLabel = item.tamanho ? ` | Tam: ${item.tamanho}` : '';
      const actorLabel = item.userNome ? ` | Usuario: ${item.userNome}` : '';
      const reasonLabel = item.motivo ? ` | Motivo: ${item.motivo}` : '';
      const noteLabel = item.observacao ? ` | Obs: ${item.observacao}` : '';
      lines.push(`- ${formatDateTimeBR(item.data)} | ${item.tipoLabel || item.tipo} | ${item.itemNome}${sizeLabel} | Delta: ${deltaLabel} | Saldo: ${item.quantidadeAnterior} -> ${item.quantidadeAtual}${actorLabel}${reasonLabel}${noteLabel}`);
    });
  }
  lines.push('');

  lines.push('POSICAO ATUAL DO ESTOQUE NA DATA DA GERACAO');
  if (!stockPosition.length) {
    lines.push('Nenhum item de estoque configurado.');
  } else {
    stockPosition.forEach(item => {
      const tamanhos = Object.entries(item.saldoPorTamanho || {}).map(([size, qty]) => `${size}:${qty}`).join(' | ');
      lines.push(`${item.nome} | Qtd atual: ${item.quantidadeTotal} | Valor unitario: ${formatCurrencyBRL(item.valorUnitario)} | Valor total estimado: ${formatCurrencyBRL(item.valorTotalEstimado)}${tamanhos ? ` | Tamanhos: ${tamanhos}` : ''}`);
    });
  }
  lines.push('');

  lines.push('INADIMPLENTES DO MES');
  if (!overdue.length) {
    lines.push('Nenhum inadimplente fechado para esta competencia.');
  } else {
    overdue.forEach(item => {
      lines.push(`- ${item.alunoNome} | Responsavel: ${item.responsavel} | Valor em aberto: ${formatCurrencyBRL(item.valor)} | Vencimento: ${formatDateBR(item.vencimento)}`);
    });
  }
  lines.push('');

  lines.push('OBSERVACOES CONTABEIS');
  lines.push('- O sistema registra vendas de uniforme e produtos como receita avulsa separada da mensalidade.');
  lines.push('- A posicao de estoque representa o saldo atual na data da geracao do relatorio.');
  lines.push('- O sistema ainda nao registra custo de compra dos itens, apenas quantidade em estoque, valor de venda e saidas por venda.');

  return lines.join('\n');
}

function normalizePdfText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
}

function escapePdfText(value) {
  return normalizePdfText(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapPdfLine(line, maxChars = 92) {
  const normalized = normalizePdfText(line);
  if (!normalized) return [''];

  const words = normalized.split(/\s+/).filter(Boolean);
  const wrapped = [];
  let currentLine = '';

  words.forEach(word => {
    if (!currentLine) {
      currentLine = word;
      return;
    }

    const candidate = `${currentLine} ${word}`;
    if (candidate.length <= maxChars) {
      currentLine = candidate;
      return;
    }

    wrapped.push(currentLine);
    currentLine = word;
  });

  if (currentLine) wrapped.push(currentLine);
  return wrapped.length ? wrapped : [''];
}

function buildSimplePdfBuffer(title, lines) {
  const pageWidth = 595;
  const pageHeight = 842;
  const marginLeft = 48;
  const startY = 796;
  const lineHeight = 14;
  const maxLinesPerPage = 50;
  const flattenedLines = [];

  flattenedLines.push(...wrapPdfLine(title || 'Relatorio FutPass', 78));
  flattenedLines.push('');
  lines.forEach(line => {
    flattenedLines.push(...wrapPdfLine(line, 92));
  });

  const pages = [];
  for (let index = 0; index < flattenedLines.length; index += maxLinesPerPage) {
    pages.push(flattenedLines.slice(index, index + maxLinesPerPage));
  }
  if (!pages.length) pages.push(['Relatorio sem conteudo.']);

  const objects = [];
  const pageObjectIds = [];
  const contentObjectIds = [];
  const fontObjectId = 3;
  let nextObjectId = 4;

  pages.forEach(() => {
    pageObjectIds.push(nextObjectId++);
    contentObjectIds.push(nextObjectId++);
  });

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  pages.forEach((pageLines, pageIndex) => {
    const contentCommands = ['BT', '/F1 10 Tf', `${marginLeft} ${startY} Td`, `${lineHeight} TL`];
    pageLines.forEach((line, lineIndex) => {
      const escaped = escapePdfText(line);
      if (lineIndex === 0) {
        contentCommands.push(`(${escaped}) Tj`);
      } else {
        contentCommands.push('T*');
        contentCommands.push(`(${escaped}) Tj`);
      }
    });
    contentCommands.push('ET');

    const contentStream = contentCommands.join('\n');
    const contentLength = Buffer.byteLength(contentStream, 'utf8');
    const contentObjectId = contentObjectIds[pageIndex];
    const pageObjectId = pageObjectIds[pageIndex];

    objects[contentObjectId] = `<< /Length ${contentLength} >>\nstream\n${contentStream}\nendstream`;
    objects[pageObjectId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let objectId = 1; objectId < objects.length; objectId += 1) {
    offsets[objectId] = Buffer.byteLength(pdf, 'utf8');
    pdf += `${objectId} 0 obj\n${objects[objectId]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += '0000000000 65535 f \n';
  for (let objectId = 1; objectId < objects.length; objectId += 1) {
    pdf += `${String(offsets[objectId]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

function buildMonthlyReport(db, year, monthIndex) {
  const mensalidades = db.alunos
    .map(aluno => getMonthlyChargeEntry(aluno, year, monthIndex))
    .filter(Boolean);

  const vendas = getSalesForMonth(db, year, monthIndex);
  const mensalidadesPagas = mensalidades.filter(item => item.status === 'Pago');
  const mensalidadesDevidas = mensalidades.filter(item => item.status === 'Devedor');
  const vendasUniforme = vendas.filter(item => item.categoria === 'uniforme');
  const vendasProdutos = vendas.filter(item => item.categoria !== 'uniforme');
  const inventoryPosition = getInventoryPositionSnapshot(db);
  const inventoryMovements = getInventoryMovementsForMonth(db, year, monthIndex);
  const salesByItem = summarizeSalesByItem(vendas);
  const monthlyChargeSummary = summarizeMonthlyCharges(mensalidades);
  const revenueByPayment = summarizeRevenueByPayment(mensalidadesPagas, vendas);
  const inventoryMovementSummary = summarizeInventoryMovements(inventoryMovements);
  const valueInCurrentStock = inventoryPosition.reduce((sum, item) => sum + item.valorTotalEstimado, 0);
  const lowStockItems = inventoryPosition.filter(item => item.estoqueBaixo);

  return {
    tipo: 'mensal',
    modelo: 'contador-detalhado-v2',
    referencia: getMonthKey(year, monthIndex),
    competencia: `${getMonthLabel(monthIndex)}/${year}`,
    geradoEm: new Date().toISOString(),
    resumo: {
      mensalidadesRecebidas: mensalidadesPagas.reduce((sum, item) => sum + item.valor, 0),
      mensalidadesEmAberto: mensalidadesDevidas.reduce((sum, item) => sum + item.valor, 0),
      vendasUniforme: vendasUniforme.reduce((sum, item) => sum + item.valor, 0),
      vendasProdutos: vendasProdutos.reduce((sum, item) => sum + item.valor, 0),
      receitaTotal: mensalidadesPagas.reduce((sum, item) => sum + item.valor, 0) + vendas.reduce((sum, item) => sum + item.valor, 0),
      alunosComMensalidade: mensalidades.length,
      valorEstoqueAtualEstimado: valueInCurrentStock,
      itensEstoqueBaixo: lowStockItems.length,
      saidasEstoqueQuantidade: salesByItem.reduce((sum, item) => sum + item.quantidade, 0),
      saidasEstoqueValor: salesByItem.reduce((sum, item) => sum + item.totalVendido, 0),
      movimentacoesEstoqueNoMes: inventoryMovements.length,
    },
    mensalidadesResumo: monthlyChargeSummary,
    vendasResumo: {
      porFormaPagamento: summarizeMonthlyCharges(vendas.map(item => ({
        formaPagamento: item.formaPagamento,
        valor: item.valor,
        status: item.categoria === 'uniforme' ? 'Uniforme' : 'Produto avulso',
      }))),
      porItem: salesByItem.map(item => ({
        itemCodigo: item.itemCodigo,
        nome: item.nome,
        categoria: item.categoria,
        quantidade: item.quantidade,
        totalVendido: item.totalVendido,
      })),
    },
    contador: {
      receitaPorFormaPagamento: revenueByPayment,
      observacoes: [
        'Mensalidades, uniformes e produtos avulsos sao consolidados separadamente.',
        'O estoque mostrado no relatorio e a posicao atual na data de geracao.',
        'O sistema nao registra custo de compra dos itens, apenas valor de venda e saldo atual.',
      ],
    },
    estoque: {
      posicaoAtualNaGeracao: inventoryPosition,
      itensComEstoqueBaixo: lowStockItems,
      movimentacoesNoMes: inventoryMovements,
      resumoMovimentacoes: inventoryMovementSummary,
      saidasNoMes: salesByItem,
    },
    mensalidades,
    vendas,
    inadimplentes: mensalidadesDevidas,
  };
}

function buildAnnualReport(db, year) {
  const months = Array.from({ length: 12 }, (_, monthIndex) => buildMonthlyReport(db, year, monthIndex));
  const itemMap = new Map();

  months.forEach(month => {
    month.vendas.forEach(item => {
      const key = item.tipo || 'Item não informado';
      const current = itemMap.get(key) || { item: key, categoria: item.categoria, quantidade: 0, total: 0 };
      current.quantidade += 1;
      current.total += Number(item.valor) || 0;
      itemMap.set(key, current);
    });
  });

  const inadimplentesFechamento = buildMonthlyReport(db, year, 11).inadimplentes;

  return {
    tipo: 'anual',
    referencia: String(year),
    competencia: `Ano ${year}`,
    geradoEm: new Date().toISOString(),
    resumo: {
      mensalidadesRecebidas: months.reduce((sum, month) => sum + month.resumo.mensalidadesRecebidas, 0),
      mensalidadesEmAberto: months.reduce((sum, month) => sum + month.resumo.mensalidadesEmAberto, 0),
      vendasUniforme: months.reduce((sum, month) => sum + month.resumo.vendasUniforme, 0),
      vendasProdutos: months.reduce((sum, month) => sum + month.resumo.vendasProdutos, 0),
      receitaTotal: months.reduce((sum, month) => sum + month.resumo.receitaTotal, 0),
    },
    meses: months.map(month => ({ competencia: month.competencia, resumo: month.resumo })),
    mensalidadesDetalhadas: months.flatMap(month => month.mensalidades.map(item => ({ competencia: month.competencia, ...item }))),
    vendasDetalhadas: months.flatMap(month => month.vendas.map(item => ({ competencia: month.competencia, ...item }))),
    resumoPorItem: Array.from(itemMap.values()).sort((a, b) => b.total - a.total),
    alunosFecharamAnoDevendo: inadimplentesFechamento,
  };
}

function getRelevantYears(db, now) {
  const years = new Set([now.getUTCFullYear()]);
  db.alunos.forEach(aluno => {
    [aluno.dataInicioPagamento, aluno.dataUltimoPagamento, aluno.dataCriacao, aluno.dataCancelamento].forEach(value => {
      const date = parseStoredDate(value);
      if (date) years.add(date.getUTCFullYear());
    });

    getNormalizedSalesForAluno(aluno).forEach(item => {
      const date = parseStoredDate(item.data);
      if (date) years.add(date.getUTCFullYear());
    });
  });

  return Array.from(years).sort((a, b) => a - b);
}

function maybeGenerateScheduledReports() {
  // Geração em disco removida para ambiente com armazenamento efêmero.
}

function buildGeneratedReportBuffer(db, tipo, year, monthIndex, formato) {
  if (tipo === 'mensal') {
    const report = buildMonthlyReport(db, year, monthIndex);
    if (formato === 'json') {
      const fileName = `relatorio-mensal-${getMonthKey(year, monthIndex)}.json`;
      return {
        fileName,
        contentType: 'application/json; charset=utf-8',
        buffer: Buffer.from(JSON.stringify(report, null, 2), 'utf8'),
      };
    }

    if (formato === 'txt') {
      const fileName = `relatorio-mensal-${getMonthKey(year, monthIndex)}-contador.txt`;
      const textContent = buildMonthlyAccountantTextReport(report);
      return {
        fileName,
        contentType: 'text/plain; charset=utf-8',
        buffer: Buffer.from(textContent, 'utf8'),
      };
    }

    if (formato === 'pdf') {
      const fileName = `relatorio-mensal-${getMonthKey(year, monthIndex)}-contador.pdf`;
      const title = `FUTPASS - RELATORIO CONTABIL ${report.competencia || ''}`.trim();
      const lines = buildMonthlyAccountantTextReport(report).split('\n');
      return {
        fileName,
        contentType: 'application/pdf',
        buffer: buildSimplePdfBuffer(title, lines),
      };
    }
  }

  if (tipo === 'anual' && formato === 'json') {
    const report = buildAnnualReport(db, year);
    const fileName = `relatorio-anual-${year}.json`;
    return {
      fileName,
      contentType: 'application/json; charset=utf-8',
      buffer: Buffer.from(JSON.stringify(report, null, 2), 'utf8'),
    };
  }

  return null;
}

function listGeneratedReports(db) {
  const now = new Date();
  const years = getRelevantYears(db, now);
  const nowIso = now.toISOString();
  const reports = [];

  years.forEach(year => {
    for (let monthIndex = 0; monthIndex <= 11; monthIndex += 1) {
      const monthKey = getMonthKey(year, monthIndex);
      reports.push({
        tipo: 'mensal',
        nome: `relatorio-mensal-${monthKey}.json`,
        formato: 'json',
        tamanho: 0,
        atualizadoEm: nowIso,
        caminho: `/api/relatorios-gerados/download?tipo=mensal&ano=${year}&mes=${monthIndex + 1}&formato=json`,
      });
      reports.push({
        tipo: 'mensal',
        nome: `relatorio-mensal-${monthKey}-contador.txt`,
        formato: 'txt',
        tamanho: 0,
        atualizadoEm: nowIso,
        caminho: `/api/relatorios-gerados/download?tipo=mensal&ano=${year}&mes=${monthIndex + 1}&formato=txt`,
      });
      reports.push({
        tipo: 'mensal',
        nome: `relatorio-mensal-${monthKey}-contador.pdf`,
        formato: 'pdf',
        tamanho: 0,
        atualizadoEm: nowIso,
        caminho: `/api/relatorios-gerados/download?tipo=mensal&ano=${year}&mes=${monthIndex + 1}&formato=pdf`,
      });
    }

    if (year < now.getUTCFullYear()) {
      reports.push({
        tipo: 'anual',
        nome: `relatorio-anual-${year}.json`,
        formato: 'json',
        tamanho: 0,
        atualizadoEm: nowIso,
        caminho: `/api/relatorios-gerados/download?tipo=anual&ano=${year}&formato=json`,
      });
    }
  });

  return reports.sort((a, b) => String(b.nome).localeCompare(String(a.nome)));
}

function cloneDb(data) {
  return JSON.parse(JSON.stringify(data || DEFAULT_DB_STATE));
}

function normalizeDbState(data) {
  const db = cloneDb(data);
  db.alunos = Array.isArray(db.alunos) ? db.alunos : [];
  db.config = db.config && typeof db.config === 'object' ? db.config : {};
  db.users = Array.isArray(db.users) ? db.users : [];
  db.accessLogs = Array.isArray(db.accessLogs) ? db.accessLogs : [];
  ensureInventoryConfig(db);
  ensureInventoryMovementsConfig(db);
  ensureReportsConfig(db);
  return db;
}

function readDb() {
  return normalizeDbState(dbCache);
}

function persistDbState(snapshot) {
  dbPersistChain = dbPersistChain.then(async () => {
    await AppState.findOneAndUpdate(
      { key: 'main' },
      {
        key: 'main',
        alunos: snapshot.alunos,
        config: snapshot.config,
        users: snapshot.users,
        accessLogs: snapshot.accessLogs,
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
  });
  return dbPersistChain;
}

function writeDb(data) {
  dbCache = normalizeDbState(data);
  return persistDbState(dbCache);
}

function saveSessionsToFile() {
  const docs = Array.from(sessions.entries()).map(([sessionId, sessionData]) => ({
    sessionId,
    userId: String(sessionData.userId || ''),
    expiresAt: Number(sessionData.expiresAt || 0),
  }));
  const activeIds = docs.map(item => item.sessionId);

  sessionPersistChain = sessionPersistChain.then(async () => {
    if (docs.length > 0) {
      const operations = docs.map((item) => ({
        updateOne: {
          filter: { sessionId: item.sessionId },
          update: {
            $set: {
              userId: item.userId,
              expiresAt: item.expiresAt,
            },
          },
          upsert: true,
        },
      }));

      await Session.bulkWrite(operations, { ordered: false });
      await Session.deleteMany({ sessionId: { $nin: activeIds } });
      return;
    }

    await Session.deleteMany({});
  });

  return sessionPersistChain;
}

function syncSessionsInBackground() {
  saveSessionsToFile().catch((error) => {
    console.error('Falha ao sincronizar sessões no MongoDB:', error);
  });
}

async function loadSessionsFromFile() {
  try {
    sessions.clear();
    const docs = await Session.find({}).lean();
    docs.forEach((item) => {
      sessions.set(String(item.sessionId || ''), {
        userId: String(item.userId || ''),
        expiresAt: Number(item.expiresAt || 0),
      });
    });
  } catch (error) {
    console.warn('Falha ao carregar sessões do MongoDB, reiniciando sessões em memória:', error);
  }
}

async function initializePersistence() {
  if (!MONGO_URI) {
    throw new Error('MONGO_URI não configurada. Defina a URI do MongoDB Atlas para iniciar em produção.');
  }

  await mongoose.connect(MONGO_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10000,
  });

  const state = await AppState.findOne({ key: 'main' }).lean();
  if (state) {
    dbCache = normalizeDbState(state);
  } else {
    dbCache = normalizeDbState(DEFAULT_DB_STATE);
    await AppState.create({ key: 'main', ...dbCache });
  }

  await loadSessionsFromFile();
}

function sendJson(res, data, status = 200) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8'),
  });
  res.end(payload);
}

function sendDownloadBuffer(res, fileName, contentType, buffer) {
  const safeFileName = String(fileName || 'arquivo').replace(/[\r\n"]/g, '_');
  res.writeHead(200, {
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename="${safeFileName}"`,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Arquivo não encontrado');
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function getContentType(arquivo) {
  const ext = path.extname(arquivo).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
  };
  return map[ext] || 'application/octet-stream';
}

function parseRequestBody(req, res) {
  return new Promise((resolve, reject) => {
    let completed = false;
    let bodyBytes = 0;
    let body = '';

    req.on('data', chunk => {
      if (completed) return;

      bodyBytes += chunk.length;
      if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
        completed = true;
        const error = new Error('Payload muito grande.');
        error.code = 'PAYLOAD_TOO_LARGE';
        if (!res.headersSent) {
          sendJson(res, { error: 'Payload muito grande. Limite de 2 MB.' }, 413);
        }
        reject(error);
        req.destroy();
        return;
      }

      body += chunk.toString('utf8');
    });

    req.on('end', () => {
      if (completed) return;
      completed = true;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

function handleRequestBodyError(res, error) {
  if (error && error.code === 'PAYLOAD_TOO_LARGE') {
    return true;
  }
  return false;
}

function getRequestHost(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
}

function getRequestProtocol(req) {
  if (req.socket && req.socket.encrypted) return 'https';
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return forwardedProto === 'https' ? 'https' : 'http';
}

function isSameOrigin(req, origin) {
  const host = getRequestHost(req);
  if (!host) return false;
  return String(origin || '').toLowerCase() === `${getRequestProtocol(req)}://${host}`;
}

function isTrustedOrigin(req, origin) {
  const normalizedOrigin = String(origin || '').trim().toLowerCase();
  if (!normalizedOrigin) return false;
  if (isSameOrigin(req, normalizedOrigin)) return true;
  if (TRUSTED_ORIGINS.has(normalizedOrigin)) return true;
  if (!IS_PRODUCTION && DEV_TRUSTED_ORIGINS.has(normalizedOrigin)) return true;
  return false;
}

function shouldSendCorsHeaders(req) {
  const origin = String(req.headers.origin || '').trim();
  return isTrustedOrigin(req, origin);
}

function isSecureRequest(req) {
  return getRequestProtocol(req) === 'https';
}

function getIdFromPath(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  return parts.length === 3 ? parts[2] : null;
}

function parseCookies(req) {
  const rawCookie = String(req.headers.cookie || '');
  const items = rawCookie.split(';');
  const cookies = {};

  for (const item of items) {
    const [name, ...rest] = item.split('=');
    if (!name) continue;
    cookies[name.trim()] = decodeURIComponent(rest.join('=').trim());
  }

  return cookies;
}

function getRequestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (forwarded) return forwarded;
  return String(req.socket.remoteAddress || 'unknown').trim() || 'unknown';
}

function setSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https://api.dicebear.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (IS_PRODUCTION && isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function isApiPath(pathname) {
  return String(pathname || '').startsWith('/api/');
}

function isStateChangingMethod(method) {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function isStateChangingApiRequest(req, pathname) {
  return isApiPath(pathname) && isStateChangingMethod(String(req.method || '').toUpperCase());
}

function extractRequestOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (origin) return origin;

  const referer = String(req.headers.referer || '').trim();
  if (!referer) return '';
  try {
    const parsed = new URL(referer);
    return parsed.origin;
  } catch (_error) {
    return '';
  }
}

function shouldBlockByOriginPolicy(req, pathname) {
  if (!ENFORCE_ORIGIN_ON_STATE_CHANGES) return false;
  if (!isStateChangingApiRequest(req, pathname)) return false;

  const origin = extractRequestOrigin(req);
  if (!origin) return true;
  return !isTrustedOrigin(req, origin);
}

function applyRateLimit(req, res, pathname) {
  if (!isApiPath(pathname)) return false;
  if (pathname === '/api/health') return false;

  const now = Date.now();
  const ip = getRequestIp(req);
  const isAuthPath = String(pathname || '').startsWith('/api/auth/');
  const routeGroup = isAuthPath ? 'auth' : 'api';
  const limit = isAuthPath ? MAX_AUTH_REQUESTS_PER_WINDOW : MAX_API_REQUESTS_PER_WINDOW;
  const key = `${routeGroup}:${ip}`;
  const entry = requestRateLimits.get(key);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    requestRateLimits.set(key, { count: 1, windowStart: now });
    return false;
  }

  entry.count += 1;
  if (entry.count <= limit) return false;

  const retryAfterSeconds = Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000));
  res.setHeader('Retry-After', String(retryAfterSeconds));
  sendJson(res, { error: 'Muitas requisições. Tente novamente em instantes.' }, 429);
  return true;
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);

  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  // Em produção, cookie seguro é obrigatório.
  if (options.secure || USE_SECURE_COOKIES) parts.push('Secure');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);

  const existing = res.getHeader('Set-Cookie');
  const next = Array.isArray(existing) ? existing.concat(parts.join('; ')) : [parts.join('; ')];
  res.setHeader('Set-Cookie', next);
}

function clearSessionCookie(res) {
  setCookie(res, SESSION_COOKIE_NAME, '', { maxAge: 0, sameSite: 'Lax' });
}

function cleanupExpiredSessions() {
  const now = Date.now();
  let removedAnySession = false;
  for (const [sessionId, session] of sessions.entries()) {
    if (!session || session.expiresAt <= now) {
      sessions.delete(sessionId);
      removedAnySession = true;
    }
  }

  if (removedAnySession) {
    syncSessionsInBackground();
  }
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    nome: user.nome,
    username: user.username,
    role: user.role,
    ativo: user.ativo !== false,
    isChief: user.isChief === true,
    criadoEm: user.criadoEm || null,
    criadoPor: user.criadoPor || null,
    ultimoLoginEm: user.ultimoLoginEm || null,
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, originalHash] = String(storedHash || '').split(':');
  if (!salt || !originalHash) return false;

  const candidateHash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  const originalBuffer = Buffer.from(originalHash, 'hex');
  const candidateBuffer = Buffer.from(candidateHash, 'hex');

  if (originalBuffer.length !== candidateBuffer.length) return false;
  return crypto.timingSafeEqual(originalBuffer, candidateBuffer);
}

function createAccessLog(db, payload) {
  db.accessLogs.unshift({
    id: 'LOG-' + Math.floor(Math.random() * 1000000000),
    data: new Date().toISOString(),
    tipo: payload.tipo,
    userId: payload.userId,
    username: payload.username,
    nome: payload.nome,
    detalhe: payload.detalhe || '',
  });
  db.accessLogs = db.accessLogs.slice(0, 200);
}

function getAuthenticatedUser(req, db) {
  cleanupExpiredSessions();
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return null;

  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    syncSessionsInBackground();
    return null;
  }

  const user = db.users.find(item => item.id === session.userId && item.ativo !== false);
  if (!user) {
    sessions.delete(sessionId);
    syncSessionsInBackground();
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { sessionId, session, user };
}

async function createSession(req, res, db, user) {
  const sessionId = crypto.randomBytes(24).toString('hex');
  sessions.set(sessionId, {
    userId: user.id,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  await saveSessionsToFile();

  user.ultimoLoginEm = new Date().toISOString();
  createAccessLog(db, {
    tipo: 'ENTRADA',
    userId: user.id,
    username: user.username,
    nome: user.nome,
    detalhe: `Acesso liberado para ${req.headers['user-agent'] || 'navegador'}`,
  });

  await writeDb(db);
  setCookie(res, SESSION_COOKIE_NAME, sessionId, {
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    sameSite: 'Lax',
  });
}

function requireAuthenticatedApi(req, res, db, options = {}) {
  if (db.users.length === 0) {
    return {
      sessionId: null,
      session: null,
      user: {
        id: 'LEGACY-OPEN-ACCESS',
        nome: 'Modo aberto',
        username: 'legacy',
        role: 'admin',
        ativo: true,
        isChief: false,
      },
    };
  }

  const auth = getAuthenticatedUser(req, db);
  if (!auth) {
    sendJson(res, { error: 'Acesso não autorizado.' }, 401);
    return null;
  }

  if (options.adminOnly && auth.user.role !== 'admin') {
    sendJson(res, { error: 'Acesso restrito ao administrador.' }, 403);
    return null;
  }

  if (options.chiefOnly && !auth.user.isChief) {
    sendJson(res, { error: 'Acesso restrito ao administrador principal.' }, 403);
    return null;
  }

  return auth;
}

// --- Proteção simples contra brute-force ---
function isBlockedLogin(key) {
  const entry = failedLogins.get(key);
  if (!entry) return false;
  if (entry.blockedUntil && entry.blockedUntil > Date.now()) return true;
  if (entry.blockedUntil && entry.blockedUntil <= Date.now()) {
    failedLogins.delete(key);
  }
  return false;
}

function recordFailedLogin(key) {
  const now = Date.now();
  const entry = failedLogins.get(key) || { count: 0, firstAt: now, blockedUntil: 0 };
  if (now - entry.firstAt > FAILED_LOGIN_BLOCK_WINDOW_MS) {
    entry.count = 1;
    entry.firstAt = now;
    entry.blockedUntil = 0;
  } else {
    entry.count = (entry.count || 0) + 1;
  }

  if (entry.count >= MAX_FAILED_LOGINS) {
    entry.blockedUntil = now + FAILED_LOGIN_BLOCK_WINDOW_MS;
  }
  failedLogins.set(key, entry);
}

function resetFailedLogin(key) {
  failedLogins.delete(key);
}

function protectPageRequest(req, res, pathname) {
  if (!PROTECTED_PAGES.has(pathname)) return false;

  const db = readDb();
  if (db.users.length === 0) {
    return false;
  }

  const auth = getAuthenticatedUser(req, db);
  if (!auth) {
    res.writeHead(302, { Location: '/index.html' });
    res.end();
    return true;
  }

  if (ADMIN_ONLY_PAGES.has(pathname) && !auth.user.isChief) {
    res.writeHead(302, { Location: '/alunos.html' });
    res.end();
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  setSecurityHeaders(req, res);

  if (isApiPath(pathname)) {
    res.setHeader('Cache-Control', 'no-store');
  }

  if (shouldSendCorsHeaders(req)) {
    res.setHeader('Access-Control-Allow-Origin', String(req.headers.origin || '').trim());
    res.setHeader('Vary', 'Origin');
  }

  maybeGenerateScheduledReports();

  if (IS_PRODUCTION && !isSecureRequest(req) && !hasWarnedInsecureTransport) {
    hasWarnedInsecureTransport = true;
    console.warn('AVISO DE SEGURANCA: NODE_ENV=production sem HTTPS detectado. Configure proxy HTTPS (Nginx/Caddy/Render/Railway) com x-forwarded-proto=https.');
  }

  if (IS_PRODUCTION && TRUSTED_ORIGINS.size === 0 && !hasWarnedMissingCorsOrigin) {
    hasWarnedMissingCorsOrigin = true;
    console.warn('AVISO DE SEGURANCA: CORS_ALLOWED_ORIGIN/CORS_ALLOWED_ORIGINS não definidos. Operações de escrita exigirão Origin same-origin estrito.');
  }

  if (req.method === 'OPTIONS') {
    const corsHeaders = {
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (shouldSendCorsHeaders(req)) {
      corsHeaders['Access-Control-Allow-Origin'] = CORS_ALLOWED_ORIGIN;
      corsHeaders.Vary = 'Origin';
    }
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  if (shouldBlockByOriginPolicy(req, pathname)) {
    return sendJson(res, { error: 'Origem não permitida para esta operação.' }, 403);
  }

  if (applyRateLimit(req, res, pathname)) {
    return;
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    const mongoState = mongoose.connection && typeof mongoose.connection.readyState === 'number'
      ? mongoose.connection.readyState
      : 0;

    return sendJson(res, {
      ok: mongoState === 1,
      service: 'futpass',
      mongoReadyState: mongoState,
      uptimeSeconds: Math.floor(process.uptime()),
      now: new Date().toISOString(),
    }, mongoState === 1 ? 200 : 503);
  }

  if (pathname === '/api/auth/status' && req.method === 'GET') {
    const db = readDb();
    const auth = getAuthenticatedUser(req, db);
    return sendJson(res, {
      authenticated: Boolean(auth),
      setupRequired: db.users.length === 0,
      user: auth ? sanitizeUser(auth.user) : null,
    });
  }

  if (pathname === '/api/auth/setup' && req.method === 'POST') {
    try {
      const db = readDb();
      if (db.users.length > 0) {
        return sendJson(res, { error: 'O administrador principal já foi configurado.' }, 409);
      }

      const body = await parseRequestBody(req, res);
      const nome = String(body.nome || '').trim();
      const username = normalizeUsername(body.username);
      const password = String(body.password || '');

      if (!nome || !username || password.length < 6) {
        return sendJson(res, { error: 'Informe nome, usuário e uma senha com pelo menos 6 caracteres.' }, 400);
      }

      const admin = {
        id: 'USER-' + Math.floor(Math.random() * 1000000000),
        nome,
        username,
        passwordHash: hashPassword(password),
        role: 'admin',
        isChief: true,
        ativo: true,
        criadoEm: new Date().toISOString(),
        criadoPor: 'SETUP',
        ultimoLoginEm: null,
      };

      db.users.push(admin);
      await createSession(req, res, db, admin);
      return sendJson(res, { success: true, user: sanitizeUser(admin) });
    } catch (error) {
      if (handleRequestBodyError(res, error)) return;
      return sendJson(res, { error: 'Não foi possível concluir a configuração inicial.' }, 400);
    }
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const db = readDb();
      if (db.users.length === 0) {
        return sendJson(res, { error: 'O administrador principal ainda não foi configurado.' }, 409);
      }

      const body = await parseRequestBody(req, res);
      const username = normalizeUsername(body.username);
      const password = String(body.password || '');
      const ip = getRequestIp(req);
      const userKey = `user:${username}`;
      const ipKey = `ip:${ip}`;

      if (isBlockedLogin(userKey) || isBlockedLogin(ipKey)) {
        return sendJson(res, { error: 'Muitas tentativas inválidas. Tente novamente mais tarde.' }, 429);
      }

      const user = db.users.find(item => normalizeUsername(item.username) === username);

      if (!user || !verifyPassword(password, user.passwordHash || '')) {
        // registrar tentativa falha por usuário e por IP
        recordFailedLogin(userKey);
        recordFailedLogin(ipKey);
        return sendJson(res, { error: 'Usuário ou senha inválidos.' }, 401);
      }

      if (user.ativo === false) {
        return sendJson(res, { error: 'Este usuário está desativado.' }, 403);
      }

      // login bem-sucedido: resetar contadores
      resetFailedLogin(userKey);
      resetFailedLogin(ipKey);

      await createSession(req, res, db, user);
      return sendJson(res, { success: true, user: sanitizeUser(user) });
    } catch (error) {
      if (handleRequestBodyError(res, error)) return;
      return sendJson(res, { error: 'Não foi possível realizar o login.' }, 400);
    }
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    try {
      const db = readDb();
      const auth = getAuthenticatedUser(req, db);
      if (auth) {
        sessions.delete(auth.sessionId);
        await saveSessionsToFile();
        createAccessLog(db, {
          tipo: 'SAIDA',
          userId: auth.user.id,
          username: auth.user.username,
          nome: auth.user.nome,
          detalhe: 'Logout manual realizado.',
        });
        await writeDb(db);
      }

      clearSessionCookie(res);
      return sendJson(res, { success: true });
    } catch (error) {
      return sendJson(res, { error: 'Não foi possível concluir o logout.' }, 500);
    }
  }

  if (pathname === '/api/users' && req.method === 'GET') {
    const db = readDb();
    const auth = requireAuthenticatedApi(req, res, db, { chiefOnly: true });
    if (!auth) return;
    return sendJson(res, db.users.map(sanitizeUser));
  }

  if (pathname === '/api/users' && req.method === 'POST') {
    try {
      const db = readDb();
      const auth = requireAuthenticatedApi(req, res, db, { chiefOnly: true });
      if (!auth) return;

      const body = await parseRequestBody(req, res);
      const id = String(body.id || '').trim();
      const nome = String(body.nome || '').trim();
      const username = normalizeUsername(body.username);
      const password = String(body.password || '');
      const role = body.role === 'admin' ? 'admin' : 'operador';
      const ativo = body.ativo !== false;

      if (!nome || !username) {
        return sendJson(res, { error: 'Nome e usuário são obrigatórios.' }, 400);
      }

      const usernameEmUso = db.users.find(item => normalizeUsername(item.username) === username && item.id !== id);
      if (usernameEmUso) {
        return sendJson(res, { error: 'Já existe um usuário com esse login.' }, 409);
      }

      if (id) {
        const existing = db.users.find(item => item.id === id);
        if (!existing) {
          return sendJson(res, { error: 'Usuário não encontrado.' }, 404);
        }

        existing.nome = nome;
        existing.username = username;
        existing.role = existing.isChief ? 'admin' : role;
        existing.ativo = existing.isChief ? true : ativo;
        if (password) {
          existing.passwordHash = hashPassword(password);
        }

        if (existing.id === auth.user.id && existing.ativo === false) {
          return sendJson(res, { error: 'Você não pode desativar seu próprio acesso.' }, 400);
        }

        await writeDb(db);
        return sendJson(res, { success: true, user: sanitizeUser(existing) });
      }

      if (password.length < 6) {
        return sendJson(res, { error: 'A senha do novo usuário deve ter pelo menos 6 caracteres.' }, 400);
      }

      const user = {
        id: 'USER-' + Math.floor(Math.random() * 1000000000),
        nome,
        username,
        passwordHash: hashPassword(password),
        role,
        isChief: false,
        ativo,
        criadoEm: new Date().toISOString(),
        criadoPor: auth.user.username,
        ultimoLoginEm: null,
      };

      db.users.push(user);
      await writeDb(db);
      return sendJson(res, { success: true, user: sanitizeUser(user) });
    } catch (error) {
      if (handleRequestBodyError(res, error)) return;
      return sendJson(res, { error: 'Não foi possível salvar o usuário.' }, 400);
    }
  }

  if (pathname.startsWith('/api/users/') && req.method === 'DELETE') {
    try {
      const db = readDb();
      const auth = requireAuthenticatedApi(req, res, db, { chiefOnly: true });
      if (!auth) return;

      const id = getIdFromPath(pathname);
      const user = db.users.find(item => item.id === id);
      if (!user) {
        return sendJson(res, { error: 'Usuário não encontrado.' }, 404);
      }

      if (user.isChief) {
        return sendJson(res, { error: 'O administrador principal não pode ser removido.' }, 400);
      }

      if (user.id === auth.user.id) {
        return sendJson(res, { error: 'Você não pode excluir seu próprio acesso.' }, 400);
      }

      db.users = db.users.filter(item => item.id !== id);
      await writeDb(db);
      return sendJson(res, { success: true });
    } catch (error) {
      return sendJson(res, { error: 'Não foi possível remover o usuário.' }, 500);
    }
  }

  if (pathname === '/api/access-logs' && req.method === 'GET') {
    const db = readDb();
    const auth = requireAuthenticatedApi(req, res, db, { chiefOnly: true });
    if (!auth) return;
    return sendJson(res, db.accessLogs.slice(0, 50));
  }

  if (pathname === '/api/estoque' && req.method === 'GET') {
    const db = readDb();
    const auth = requireAuthenticatedApi(req, res, db);
    if (!auth) return;
    return sendJson(res, ensureInventoryConfig(db));
  }

  if (pathname === '/api/estoque/movimentacoes' && req.method === 'GET') {
    const db = readDb();
    const auth = requireAuthenticatedApi(req, res, db);
    if (!auth) return;
    return sendJson(res, ensureInventoryMovementsConfig(db).slice(0, 200));
  }

  if (pathname === '/api/estoque' && req.method === 'POST') {
    try {
      const db = readDb();
      const auth = requireAuthenticatedApi(req, res, db);
      if (!auth) return;

      const body = await parseRequestBody(req, res);
      const previousInventory = ensureInventoryConfig(db);
      const defaults = getDefaultInventory();
      const payload = body && typeof body === 'object' ? body : {};
      const incoming = payload.inventory && typeof payload.inventory === 'object' ? payload.inventory : payload;
      const nextInventory = {};

      for (const [key, item] of Object.entries(defaults)) {
        const incomingItem = incoming[key] && typeof incoming[key] === 'object' ? incoming[key] : {};
        const incomingSizes = incomingItem.tamanhos && typeof incomingItem.tamanhos === 'object' ? incomingItem.tamanhos : {};
        nextInventory[key] = {
          nome: incomingItem.nome || item.nome,
          valor: Math.max(0, Number(incomingItem.valor ?? item.valor) || 0),
          tamanhos: {
            P: Math.max(0, Number(incomingSizes.P ?? item.tamanhos.P) || 0),
            M: Math.max(0, Number(incomingSizes.M ?? item.tamanhos.M) || 0),
            G: Math.max(0, Number(incomingSizes.G ?? item.tamanhos.G) || 0),
            GG: Math.max(0, Number(incomingSizes.GG ?? item.tamanhos.GG) || 0),
          },
        };
      }

      registerInventorySnapshotChanges(db, previousInventory, nextInventory, auth, payload.movimento);
      db.config.estoque = nextInventory;
      await writeDb(db);
      return sendJson(res, nextInventory);
    } catch (error) {
      if (handleRequestBodyError(res, error)) return;
      return sendJson(res, { error: 'Não foi possível salvar o estoque.' }, 400);
    }
  }

  if (pathname === '/api/relatorios' && req.method === 'GET') {
    const db = readDb();
    const auth = requireAuthenticatedApi(req, res, db);
    if (!auth) return;
    return sendJson(res, ensureReportsConfig(db));
  }

  if (pathname === '/api/relatorios-gerados' && req.method === 'GET') {
    const db = readDb();
    const auth = requireAuthenticatedApi(req, res, db);
    if (!auth) return;
    return sendJson(res, listGeneratedReports(db));
  }

  if (pathname === '/api/relatorios-gerados/download' && req.method === 'GET') {
    const db = readDb();
    const auth = requireAuthenticatedApi(req, res, db);
    if (!auth) return;

    const tipo = String(parsedUrl.query.tipo || '').toLowerCase();
    const formato = String(parsedUrl.query.formato || '').toLowerCase();
    const year = Number(parsedUrl.query.ano);
    const monthIndex = Number(parsedUrl.query.mes) - 1;

    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return sendJson(res, { error: 'Ano inválido para geração do relatório.' }, 400);
    }

    if (tipo === 'mensal' && (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11)) {
      return sendJson(res, { error: 'Mês inválido para geração do relatório mensal.' }, 400);
    }

    const generated = buildGeneratedReportBuffer(db, tipo, year, monthIndex, formato);
    if (!generated) {
      return sendJson(res, { error: 'Formato de relatório não suportado.' }, 400);
    }

    return sendDownloadBuffer(res, generated.fileName, generated.contentType, generated.buffer);
  }

  if (pathname === '/api/relatorios' && req.method === 'POST') {
    try {
      const db = readDb();
      const auth = requireAuthenticatedApi(req, res, db);
      if (!auth) return;

      const body = await parseRequestBody(req, res);
      const nome = String(body.nome || '').trim();
      const tipo = String(body.tipo || '').trim();
      const tamanho = Number(body.tamanho || 0);
      const conteudo = String(body.conteudo || '');

      if (!nome || !conteudo) {
        return sendJson(res, { error: 'Arquivo de relatório inválido.' }, 400);
      }

      if (tamanho > 3 * 1024 * 1024) {
        return sendJson(res, { error: 'O relatório excede o limite de 3 MB.' }, 400);
      }

      const relatorios = ensureReportsConfig(db);
      const relatorio = {
        id: 'REL-' + Math.floor(Math.random() * 1000000000),
        nome,
        tipo: tipo || 'application/octet-stream',
        tamanho,
        conteudo,
        enviadoEm: new Date().toISOString(),
      };

      relatorios.unshift(relatorio);
      db.config.relatorios = relatorios.slice(0, 20);
      await writeDb(db);
      return sendJson(res, relatorio);
    } catch (error) {
      if (handleRequestBodyError(res, error)) return;
      return sendJson(res, { error: 'Não foi possível subir o relatório.' }, 400);
    }
  }

  if (pathname.startsWith('/api/relatorios/') && req.method === 'DELETE') {
    try {
      const db = readDb();
      const auth = requireAuthenticatedApi(req, res, db);
      if (!auth) return;

      const id = getIdFromPath(pathname);
      const relatorios = ensureReportsConfig(db);
      const originalLength = relatorios.length;
      db.config.relatorios = relatorios.filter(item => item.id !== id);
      if (db.config.relatorios.length === originalLength) {
        return sendJson(res, { error: 'Relatório não encontrado.' }, 404);
      }

      await writeDb(db);
      return sendJson(res, { success: true });
    } catch (error) {
      return sendJson(res, { error: 'Não foi possível excluir o relatório.' }, 500);
    }
  }

  if (pathname === '/api/alunos' && req.method === 'GET') {
    const db = readDb();
    const auth = requireAuthenticatedApi(req, res, db);
    if (!auth) return;
    return sendJson(res, db.alunos);
  }

  if (pathname.startsWith('/api/alunos/') && req.method === 'GET') {
    const db = readDb();
    const auth = requireAuthenticatedApi(req, res, db);
    if (!auth) return;
    const id = getIdFromPath(pathname);
    const aluno = db.alunos.find(a => a.id === id);
    if (!aluno) return sendJson(res, { error: 'Aluno não encontrado' }, 404);
    return sendJson(res, aluno);
  }

  if (pathname === '/api/alunos' && req.method === 'POST') {
    try {
      const db = readDb();
      const auth = requireAuthenticatedApi(req, res, db);
      if (!auth) return;

      const aluno = await parseRequestBody(req, res);
      if (!aluno || !aluno.nome) {
        return sendJson(res, { error: 'Dados do aluno inválidos.' }, 400);
      }

      const index = db.alunos.findIndex(a => a.id === aluno.id);

      if (index >= 0) {
        db.alunos[index] = Object.assign(db.alunos[index], aluno);
        await writeDb(db);
        return sendJson(res, db.alunos[index]);
      }

      aluno.id = aluno.id || 'ALUNO-' + Math.floor(Math.random() * 1000000);
      aluno.dataCriacao = aluno.dataCriacao || new Date().toISOString();
      aluno.statusMatricula = aluno.statusMatricula || 'Ativo';
      aluno.statusFinanceiro = aluno.statusFinanceiro || 'Pago';
      aluno.formaPagamento = aluno.formaPagamento || 'PIX';
      aluno.mensalidadeValor = Number.isFinite(Number(aluno.mensalidadeValor)) ? Math.max(0, Number(aluno.mensalidadeValor)) : getPlanValue(aluno.planoEscolhido);
      aluno.avatar = aluno.avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + encodeURIComponent(aluno.nome);

      db.alunos.push(aluno);
      await writeDb(db);
      return sendJson(res, aluno);
    } catch (error) {
      if (handleRequestBodyError(res, error)) return;
      return sendJson(res, { error: 'Erro ao processar o aluno.' }, 400);
    }
  }

  if (pathname.startsWith('/api/alunos/') && req.method === 'DELETE') {
    try {
      const db = readDb();
      const auth = requireAuthenticatedApi(req, res, db);
      if (!auth) return;

      const id = getIdFromPath(pathname);
      const originalLength = db.alunos.length;
      db.alunos = db.alunos.filter(a => a.id !== id);
      if (db.alunos.length === originalLength) {
        return sendJson(res, { error: 'Aluno não encontrado' }, 404);
      }
      await writeDb(db);
      return sendJson(res, { success: true });
    } catch (error) {
      return sendJson(res, { error: 'Não foi possível excluir o aluno.' }, 500);
    }
  }

  let arquivoSolicitado = pathname;
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(302, { Location: '/login.html' });
    res.end();
    return;
  }

  if (protectPageRequest(req, res, arquivoSolicitado)) {
    return;
  }

  const staticRelativePath = path.posix.normalize(String(arquivoSolicitado || '/')).replace(/^\/+/, '');
  const staticExtension = path.extname(staticRelativePath).toLowerCase();

  if (!ALLOWED_STATIC_EXTENSIONS.has(staticExtension)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Arquivo não encontrado');
  }

  const caminhoArquivo = path.resolve(PUBLIC_ROOT, staticRelativePath);

  if (!caminhoArquivo.startsWith(PUBLIC_ROOT + path.sep)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Requisição inválida');
  }

  if (fs.existsSync(caminhoArquivo) && fs.statSync(caminhoArquivo).isFile()) {
    return sendFile(res, caminhoArquivo, getContentType(caminhoArquivo));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Arquivo não encontrado');
});

server.on('error', (error) => {
  if (!error || typeof error !== 'object') {
    console.error('Falha desconhecida ao iniciar servidor.');
    process.exit(1);
    return;
  }

  if (error.code === 'EADDRINUSE') {
    console.error(`Falha ao iniciar: porta ${PORT} já está em uso.`);
    process.exit(1);
    return;
  }

  if (error.code === 'EACCES') {
    console.error(`Falha ao iniciar: sem permissão para escutar na porta ${PORT}.`);
    process.exit(1);
    return;
  }

  console.error('Falha ao iniciar servidor:', error);
  process.exit(1);
});

async function startServer() {
  try {
    await initializePersistence();
    server.listen(PORT, () => {
      maybeGenerateScheduledReports();
      if (IS_PRODUCTION && process.env.USE_SECURE_COOKIES !== 'true') {
        console.warn('AVISO DE SEGURANCA: em produção, USE_SECURE_COOKIES foi forçado para true.');
      }
      console.log(`Servidor Arena 01 rodando em http://0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error('Falha crítica ao inicializar persistência MongoDB:', error);
    process.exit(1);
  }
}

startServer();
