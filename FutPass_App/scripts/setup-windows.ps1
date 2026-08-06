Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host '== FutPass Setup Windows ==' -ForegroundColor Cyan

if (-not (Test-Path '.\\package.json')) {
  Write-Host 'ERRO: execute este script dentro da pasta FutPass_App.' -ForegroundColor Red
  exit 1
}

if (-not (Test-Path '.\\.env')) {
  if (Test-Path '.\\.env.example') {
    Copy-Item '.\\.env.example' '.\\.env'
    Write-Host 'Arquivo .env criado a partir de .env.example.' -ForegroundColor Yellow
    Write-Host 'Edite o .env e preencha MONGO_URI antes de continuar.' -ForegroundColor Yellow
  } else {
    Write-Host 'ERRO: .env.example não encontrado.' -ForegroundColor Red
    exit 1
  }
}

Write-Host 'Instalando dependências...' -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'Executando preflight de ambiente...' -ForegroundColor Cyan
npm run preflight
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'Setup concluído. Para migrar dados antigos execute:' -ForegroundColor Green
Write-Host 'npm run migrate:json-to-mongo' -ForegroundColor Green
Write-Host 'Para iniciar o sistema:' -ForegroundColor Green
Write-Host 'npm start' -ForegroundColor Green
