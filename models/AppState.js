const mongoose = require('mongoose');

const UniformeTamanhosSchema = new mongoose.Schema({
  P: { type: Number, default: 0 },
  M: { type: Number, default: 0 },
  G: { type: Number, default: 0 },
  GG: { type: Number, default: 0 },
}, { _id: false });

const UniformeItemSchema = new mongoose.Schema({
  nome: { type: String, default: '' },
  valor: { type: Number, default: 0 },
  tamanhos: { type: UniformeTamanhosSchema, default: () => ({}) },
}, { _id: false });

const FinanceiroRelatorioSchema = new mongoose.Schema({
  id: { type: String, required: true },
  nome: { type: String, required: true },
  tipo: { type: String, default: 'application/octet-stream' },
  tamanho: { type: Number, default: 0 },
  conteudo: { type: String, default: '' },
  enviadoEm: { type: String, default: '' },
}, { _id: false });

const ConfigSchema = new mongoose.Schema({
  estoque: {
    uniformeCompleto: { type: UniformeItemSchema, default: () => ({}) },
    camiseta: { type: UniformeItemSchema, default: () => ({}) },
    calcao: { type: UniformeItemSchema, default: () => ({}) },
    meiao: { type: UniformeItemSchema, default: () => ({}) },
    caneleira: { type: UniformeItemSchema, default: () => ({}) },
  },
  estoqueMovimentacoes: { type: [mongoose.Schema.Types.Mixed], default: [] },
  relatorios: { type: [FinanceiroRelatorioSchema], default: [] },
}, { _id: false, strict: false });

const AlunoSchema = new mongoose.Schema({}, {
  _id: false,
  strict: false,
});

const UsuarioSchema = new mongoose.Schema({
  id: { type: String, required: true },
  nome: { type: String, default: '' },
  username: { type: String, default: '' },
  passwordHash: { type: String, default: '' },
  role: { type: String, default: 'operador' },
  isChief: { type: Boolean, default: false },
  ativo: { type: Boolean, default: true },
  criadoEm: { type: String, default: '' },
  criadoPor: { type: String, default: '' },
  ultimoLoginEm: { type: String, default: '' },
}, { _id: false, strict: false });

const AccessLogSchema = new mongoose.Schema({
  id: { type: String, required: true },
  data: { type: String, default: '' },
  tipo: { type: String, default: '' },
  userId: { type: String, default: '' },
  username: { type: String, default: '' },
  nome: { type: String, default: '' },
  detalhe: { type: String, default: '' },
}, { _id: false });

const AppStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'main' },
  alunos: { type: [AlunoSchema], default: [] },
  users: { type: [UsuarioSchema], default: [] },
  accessLogs: { type: [AccessLogSchema], default: [] },
  config: { type: ConfigSchema, default: () => ({}) },
}, {
  timestamps: true,
  minimize: false,
});

module.exports = mongoose.models.AppState || mongoose.model('AppState', AppStateSchema);
