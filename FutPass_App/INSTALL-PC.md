# INSTALACAO EM OUTRO PC - FUTPASS

Este guia instala o FutPass em outro computador com persistencia em MongoDB Atlas.

## 1. Requisitos

- Windows 10/11 (ou Linux)
- Node.js LTS (18+)
- Conta no MongoDB Atlas (free tier)

## 2. Copiar o projeto

Copie a pasta `FutPass_App` para o novo PC mantendo a estrutura original.

## 3. Instalar dependencias

No PowerShell, dentro de `FutPass_App`:

```powershell
npm install
```

Ou execute setup automatizado:

```powershell
npm run setup:windows
```

## 4. Configurar ambiente

1. Copie `.env.example` para `.env`.
2. Preencha ao menos:
   - `MONGO_URI`
   - `NODE_ENV=production`
   - `USE_SECURE_COOKIES=true`

Exemplo de `.env`:

```env
NODE_ENV=production
PORT=3000
MONGO_URI=mongodb+srv://usuario:senha@cluster0.xxxxx.mongodb.net/futpass?retryWrites=true&w=majority
USE_SECURE_COOKIES=true
CORS_ALLOWED_ORIGIN=
```

## 5. Migrar dados legados (se houver)

Se voce trouxe `db.json` e `sessions.json` antigos:

```powershell
npm run migrate:json-to-mongo
```

## 6. Iniciar sistema

Antes de iniciar em produção local, rode:

```powershell
npm run preflight
```

```powershell
npm start
```

Acesse no navegador:

- `http://localhost:3000/login.html`

## 7. Fluxo do administrador master

- No primeiro acesso, crie o administrador principal (master) em `/api/auth/setup` pela tela de login.
- Somente o administrador principal pode gerenciar usuarios (criar, editar, excluir).
- O administrador principal nao pode ser removido pelo sistema.

## 8. Verificacoes obrigatorias

- Login do administrador
- Cadastro/edicao/exclusao de aluno
- Fluxo de uniformes e financeiro
- Gestao de usuarios
- Download de relatorios gerados (json/txt/pdf)

## 9. Backup operacional recomendado

Mesmo com MongoDB Atlas, faça export periodico:

- `mongodump` semanal
- export JSON das colecoes `appstates` e `sessions`
