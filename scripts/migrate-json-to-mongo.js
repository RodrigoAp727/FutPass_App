const fs = require('fs');
const path = require('path');
require('dotenv').config();
const mongoose = require('mongoose');
const AppState = require('../models/AppState');
const Session = require('../models/Session');

const ROOT = path.resolve(__dirname, '..');
const DB_JSON = path.join(ROOT, 'db.json');
const SESSIONS_JSON = path.join(ROOT, 'sessions.json');
const MONGO_URI = String(process.env.MONGO_URI || '').trim();

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Falha ao ler ${path.basename(filePath)}: ${error.message}`);
  }
}

function normalizeState(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  return {
    key: 'main',
    alunos: Array.isArray(data.alunos) ? data.alunos : [],
    config: data.config && typeof data.config === 'object' ? data.config : {},
    users: Array.isArray(data.users) ? data.users : [],
    accessLogs: Array.isArray(data.accessLogs) ? data.accessLogs : [],
  };
}

function normalizeSessions(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).map(([sessionId, value]) => ({
    sessionId: String(sessionId || '').trim(),
    userId: String(value && value.userId ? value.userId : '').trim(),
    expiresAt: Number(value && value.expiresAt ? value.expiresAt : 0),
  })).filter(item => item.sessionId && item.userId && Number.isFinite(item.expiresAt));
}

async function run() {
  if (!MONGO_URI) {
    throw new Error('MONGO_URI não configurada. Defina no ambiente antes de migrar.');
  }

  const dbRaw = readJsonIfExists(DB_JSON, { alunos: [], config: {}, users: [], accessLogs: [] });
  const sessionsRaw = readJsonIfExists(SESSIONS_JSON, {});

  const state = normalizeState(dbRaw);
  const sessions = normalizeSessions(sessionsRaw);

  await mongoose.connect(MONGO_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10000,
  });

  await AppState.findOneAndUpdate(
    { key: 'main' },
    state,
    { upsert: true, setDefaultsOnInsert: true },
  );

  await Session.deleteMany({});
  if (sessions.length > 0) {
    await Session.insertMany(sessions, { ordered: false });
  }

  console.log('Migração concluída com sucesso.');
  console.log(`Alunos: ${state.alunos.length}`);
  console.log(`Usuários: ${state.users.length}`);
  console.log(`Sessões: ${sessions.length}`);

  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error('Erro na migração:', error.message || error);
  try {
    await mongoose.disconnect();
  } catch (e) {
    // noop
  }
  process.exit(1);
});
