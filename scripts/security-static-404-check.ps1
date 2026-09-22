param(
  [string]$BaseUrl = 'http://127.0.0.1:3000'
)

$targets = @(
  '/db.json',
  '/sessions.json',
  '/server.js',
  '/package.json',
  '/backups/db-2026-05-26T21-15-28-613Z.json'
)

$failures = @()

foreach ($path in $targets) {
  $url = "$BaseUrl$path"
  $statusCode = $null

  try {
    $response = Invoke-WebRequest -Uri $url -Method GET -MaximumRedirection 0 -ErrorAction Stop
    $statusCode = [int]$response.StatusCode
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $statusCode = [int]$_.Exception.Response.StatusCode
    } else {
      Write-Host "ERRO em ${url}: $($_.Exception.Message)"
      $failures += "$path => erro de conexão"
      continue
    }
  }

  if ($statusCode -ne 404) {
    Write-Host "FALHA: $path retornou $statusCode (esperado 404)"
    $failures += "$path => $statusCode"
  } else {
    Write-Host "OK: $path retornou 404"
  }
}

if ($failures.Count -gt 0) {
  Write-Host ''
  Write-Host 'Resultado: FALHOU'
  $failures | ForEach-Object { Write-Host " - $_" }
  exit 1
}

Write-Host ''
Write-Host 'Resultado: SUCESSO (todos os endpoints sensíveis retornaram 404).'
exit 0
