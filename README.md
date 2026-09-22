# ⚽ FutPass — Gestão de Escolinhas de Futebol

![Status](https://img.shields.io/badge/Status-Em_Producao-brightgreen?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-18+-6DA55F?style=for-the-badge&logo=node.js&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB_Atlas-47A248?style=for-the-badge&logo=mongodb&logoColor=white)

## 📋 Sobre o Projeto

O **FutPass** é uma plataforma de gestão para escolinhas e academias de futebol: cadastro e controle de alunos, financeiro (mensalidades) e uniformes, com login e controle de acesso por usuário. É a versão evoluída e em produção do projeto, migrada de armazenamento em arquivo local (`db.json`) para **MongoDB Atlas**.

**Diferencial técnico:** o servidor HTTP, o roteamento, a autenticação por sessão e os cookies seguros foram implementados usando apenas o módulo `http` nativo do Node.js, sem framework (Express, Fastify etc.) — decisão deliberada para demonstrar entendimento do protocolo HTTP e do ciclo de requisição/resposta por baixo do capô.

## 🎯 Funcionalidades

- **Autenticação e usuários** — login com sessão e controle de acesso (`login.html`, `users.html`, `auth.js`)
- **Gestão de alunos** — cadastro e listagem (`alunos.html`, `cadastro.html`)
- **Financeiro** — controle de mensalidades (`financeiro.html`)
- **Uniformes** — módulo de controle de uniformes (`uniformes.html`)
- **Migração de dados legados** — script para importar bases antigas em `db.json`/`sessions.json` para o MongoDB (`scripts/migrate-json-to-mongo.js`)

## 🔐 Segurança

- Cookies de sessão seguros (`USE_SECURE_COOKIES`) e forçados em produção
- Validação de origem em mudanças de estado (`ENFORCE_ORIGIN_ON_STATE_CHANGES`)
- CORS restrito a um domínio configurável
- Script de checagem de segurança estática antes do deploy (`scripts/security-static-404-check.ps1`)

## 🛠️ Stack Técnico

- **Backend:** Node.js (módulo `http` nativo, sem framework)
- **Banco de dados:** MongoDB Atlas via Mongoose
- **Deploy:** Render (configuração pronta em `render.yaml`)
- **Frontend:** HTML/CSS/JS

## 🚀 Como rodar localmente

### Requisitos
- Node.js 18+
- MongoDB Atlas (cluster M0 gratuito)

### Passos

```powershell
npm install
```

Configure as variáveis de ambiente copiando `.env.example` para `.env` e preenchendo `MONGO_URI`.

```powershell
npm start
```

### Migração de dados legados

Se você possui `db.json` e `sessions.json` antigos:

```powershell
npm run migrate:json-to-mongo
```

## 📚 Documentação operacional

- Instalação em outro PC: [`INSTALL-PC.md`](INSTALL-PC.md)
- Deploy no Render (gratuito): [`DEPLOY-RENDER.md`](DEPLOY-RENDER.md)
- Segurança e variáveis de ambiente: [`DEPLOY.md`](DEPLOY.md)

### Checklist de segurança para produção

- `NODE_ENV=production`
- `USE_SECURE_COOKIES=true`
- `ENFORCE_ORIGIN_ON_STATE_CHANGES=true`
- `CORS_ALLOWED_ORIGIN` preenchido com o domínio oficial
- Atlas sem `0.0.0.0/0` permanente (usar faixa restrita quando possível)

---
*Desenvolvido por [RodrigoAp727](https://github.com/RodrigoAp727)*
