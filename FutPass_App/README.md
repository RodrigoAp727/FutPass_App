# FutPass - Guia Rápido

Este projeto está preparado para rodar com persistência em MongoDB Atlas (não usa mais db.json/sessions.json em produção).

## Requisitos

- Node.js 18+
- MongoDB Atlas (cluster M0 gratuito)

## Primeiros passos

1. Instale dependências:

```powershell
npm install
```

1. Configure variáveis de ambiente copiando `.env.example` para `.env` e preenchendo `MONGO_URI`.

1. Inicie:

```powershell
npm start
```

## Migração de dados legados

Se você possui `db.json` e `sessions.json` antigos:

```powershell
npm run migrate:json-to-mongo
```

## Documentação operacional

- Instalação em outro PC: `INSTALL-PC.md`
- Deploy no Render gratuito: `DEPLOY-RENDER.md`
- Segurança e variáveis gerais: `DEPLOY.md`
