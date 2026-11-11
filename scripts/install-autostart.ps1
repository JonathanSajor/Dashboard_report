param(
  [switch]$Remove
)

$taskName = 'ReporteProduccionAutoStart'

if ($Remove) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host 'Se quitó la tarea de inicio automático.'
  } else {
    Write-Host 'La tarea de inicio automático no estaba instalada.'
  }
  exit 0
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path (Join-Path $projectRoot 'package.json'))) {
  throw "No se encontró package.json en $projectRoot."
}

$runnerPath = Join-Path $PSScriptRoot 'run-with-restart.ps1'
$powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction `
  -Execute $powerShellPath `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`"" `
  -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal `
  -UserId $userId `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Inicia el backend de Reporte de Producción al iniciar sesión y lo reinicia si termina.' `
  -Force | Out-Null

Write-Host "Inicio automático configurado para $userId."
Write-Host 'La tarea se ejecutará al iniciar sesión en Windows. Cierra sesión e inicia nuevamente para probarla.'
