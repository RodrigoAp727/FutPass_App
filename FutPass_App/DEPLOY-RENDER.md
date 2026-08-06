# DEPLOY NO RENDER (CAMADA GRATUITA)

## Recomendacao tecnica

Para este projeto, Render e a opcao gratuita mais previsivel para Node.js simples, com deploy por Git e variaveis de ambiente. O Railway e bom, mas costuma depender de creditos/uso mensal e pode variar custo com facilidade.

## 1. Subir codigo no GitHub

Publique a pasta `FutPass_App` no repositorio.

## 2. Criar Web Service no Render

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Branch: principal

## 3. Variaveis de ambiente no Render

Defina:

- `NODE_ENV=production`
- `MONGO_URI=<sua URI MongoDB Atlas>`
- `USE_SECURE_COOKIES=true`
- `CORS_ALLOWED_ORIGIN=https://futpass-app.onrender.com` (ou seu dominio oficial)
- `CORS_ALLOWED_ORIGINS=` (opcional, lista separada por virgula)
- `ENFORCE_ORIGIN_ON_STATE_CHANGES=true`
- `RATE_LIMIT_MAX_API=600`
- `RATE_LIMIT_MAX_AUTH=80`
- `MAX_FAILED_LOGINS=5`
- `FAILED_LOGIN_WINDOW_MS=900000`
- `PORT` nao precisa definir manualmente no Render (host injeta automaticamente)

## 4. MongoDB Atlas (free tier)

- Crie cluster M0
- Crie usuario de banco
- Em Network Access, libere IPs do Render (ou `0.0.0.0/0` com senha forte)
- Copie URI e coloque em `MONGO_URI`

Importante para longo prazo:

- Evite manter `0.0.0.0/0` permanentemente no Atlas.
- Use faixa controlada/IPs necessarios quando possivel.

## 5. Migracao inicial de dados

Se vier de base antiga:

1. Rode local com `.env` apontando para Atlas.
2. Execute:

```powershell
npm run migrate:json-to-mongo
```

## 6. Teste de aceite apos deploy

- Login OK
- Alunos CRUD OK
- Uniformes/financeiro OK
- Usuarios OK
- Download de relatorios em memoria (`/api/relatorios-gerados/download`) OK
- Endpoints sensiveis (`/db.json`, `/sessions.json`, `/server.js`) retornando 404
- Preflight CORS de origem oficial retorna `access-control-allow-origin`
- Preflight CORS de origem nao autorizada NAO retorna `access-control-allow-origin`

## 7. Regras do administrador master

- O primeiro usuario criado no setup vira administrador principal (master).
- Somente esse perfil pode criar, editar e excluir outros usuarios.
- O master nao pode ser removido pelo sistema.

## 8. Limitacoes da camada gratuita

- Pode haver cold start apos periodo de inatividade.
- Nao existe garantia de SLA.
- Para operacao escolar critica em horario fixo, considere plano pago futuramente.
