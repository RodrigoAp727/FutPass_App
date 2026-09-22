# DEPLOY SEGURO - Arena 01 / FutPass_App

Este documento descreve o deploy seguro para produção e os procedimentos operacionais mínimos.

## 1) Variáveis de ambiente

- PORT
  - Porta HTTP do processo Node.
  - Padrão: 3000.
  - Exemplo: PORT=3000.

- NODE_ENV
  - Ambiente de execução.
  - Em produção, usar NODE_ENV=production.
  - Quando NODE_ENV=production, cookies de sessão são forçados para Secure.

- USE_SECURE_COOKIES
  - Fora de produção: controla se o cookie de sessão usa atributo Secure.
  - Em produção: é forçado para true (mesmo que a variável esteja ausente ou false).
  - Recomendado manter como true em qualquer ambiente com HTTPS.

- CORS_ALLOWED_ORIGIN
  - Origem permitida para cabeçalhos CORS.
  - Se vazio, o servidor não libera CORS aberto.
  - Como o frontend é servido no mesmo domínio/porta, o ideal em produção é manter vazio.
  - Use somente se realmente precisar liberar outra origem específica.

- CORS_ALLOWED_ORIGINS
  - Lista opcional de origens adicionais separadas por virgula.
  - Use somente quando houver mais de um frontend oficial.

- ENFORCE_ORIGIN_ON_STATE_CHANGES
  - Quando true, rotas de escrita em /api (POST/PUT/PATCH/DELETE) exigem Origin/Referer confiavel.
  - Em producao, recomenda-se manter true permanentemente.

- RATE_LIMIT_MAX_API / RATE_LIMIT_MAX_AUTH
  - Limita volume de requests por IP em janela de 15 minutos.
  - `RATE_LIMIT_MAX_AUTH` deve ser mais restritivo para reduzir abuso de login.

- MAX_FAILED_LOGINS / FAILED_LOGIN_WINDOW_MS
  - Define limite de tentativas de login invalidas e tempo de bloqueio.
  - Recomendado: 5 tentativas e janela de 900000 ms (15 min).

## 2) Obrigatório em produção: HTTPS via proxy reverso

O servidor Node roda HTTP puro e deve ficar atrás de HTTPS.

Opções recomendadas:

- Nginx com certificado TLS válido.
- Caddy com TLS automático.
- Plataformas com TLS gerenciado (Render, Railway e similares).

Requisitos:

- Encaminhar tráfego externo apenas em HTTPS.
- Encaminhar header x-forwarded-proto=https até o Node.
- Não expor porta HTTP sem proteção pública direta.

## 2.1) Headers de seguranca aplicados pelo servidor

O backend envia automaticamente:

- Strict-Transport-Security (quando HTTPS detectado em producao)
- X-Content-Type-Options: nosniff
- X-Frame-Options: DENY
- Referrer-Policy: no-referrer
- Permissions-Policy restritiva
- Content-Security-Policy para reduzir superficie de XSS/clickjacking
- Cache-Control: no-store para /api

## 3) Primeiro setup do administrador-chefe

Fluxo recomendado:

1. Suba o sistema em produção sem usuários cadastrados.
2. Acesse a tela de login no domínio oficial.
3. O sistema detecta setup inicial e pede criação do administrador-chefe.
4. Defina nome, usuário e senha forte (mínimo 6, recomendado 12+ com complexidade).
5. Após criar, valide login e acesso às telas protegidas.

Observações:

- O primeiro usuário criado recebe isChief=true e role=admin.
- Apenas o administrador-chefe pode gerenciar usuários.

## 4) Restauração manual de backup do db.json (emergência)

Use quando houver corrupção de dados ou necessidade de rollback.

Passos:

1. Pare o processo Node.
2. Faça cópia de segurança do db.json atual.
3. Escolha um arquivo em backups/ (exemplo: backups/db-2026-05-26T21-15-28-613Z.json).
4. Copie o backup para db.json na raiz do projeto.
5. Verifique permissões de leitura/escrita do arquivo.
6. Suba novamente o servidor.
7. Valide login e consistência básica dos dados.

Comandos de exemplo (PowerShell):

- Stop-Process -Name node
- Copy-Item .\db.json .\db.json.pre-restore.bak
- Copy-Item .\backups\db-AAAA-MM-DDTHH-mm-ss-SSSZ.json .\db.json
- node .\server.js

## 5) Verificação pós-deploy de exposição indevida de arquivos

Com o servidor rodando, execute:

- powershell -ExecutionPolicy Bypass -File .\scripts\security-static-404-check.ps1 -BaseUrl "<http://127.0.0.1:3000>"

O script valida que os seguintes caminhos retornam 404:

- /db.json
- /sessions.json
- /server.js
- /package.json
- /backups/db-2026-05-26T21-15-28-613Z.json
