require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = String(process.env.MONGO_URI || '').trim();
const NODE_ENV = String(process.env.NODE_ENV || 'development').trim();
const USE_SECURE_COOKIES = String(process.env.USE_SECURE_COOKIES || '').trim();

function fail(message) {
  console.error(`ERRO: ${message}`);
  process.exit(1);
}

async function run() {
  if (!MONGO_URI) {
    fail('MONGO_URI não configurada. Defina no arquivo .env ou no ambiente.');
  }

  if (NODE_ENV === 'production' && USE_SECURE_COOKIES !== 'true') {
    console.warn('AVISO: USE_SECURE_COOKIES diferente de true; o servidor força true em produção, mas ajuste o ambiente.');
  }

  try {
    await mongoose.connect(MONGO_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 10000,
    });

    await mongoose.connection.db.admin().ping();
    console.log('OK: Conexão MongoDB Atlas validada com sucesso.');
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    fail(`Falha ao conectar no MongoDB Atlas: ${error.message || error}`);
  }
}

run();
