$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$retryDelaySeconds = 30
Set-Location $projectRoot

while ($true) {
  $npmCommand = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
  if (-not $npmCommand) {
    Write-Warning 'No se encuentra npm.cmd. Comprueba que Node.js esté instalado y disponible en PATH.'
    Start-Sleep -Seconds $retryDelaySeconds
    continue
  }

  Write-Host "Iniciando el backend en $projectRoot"
  & $npmCommand.Source start
  $exitCode = $LASTEXITCODE
  Write-Warning "npm start terminó con código $exitCode. Se reintentará en $retryDelaySeconds segundos."
  Start-Sleep -Seconds $retryDelaySeconds
}
