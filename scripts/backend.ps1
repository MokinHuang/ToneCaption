# Backend control for ToneCaption (FastAPI + SenseVoice on port 8000).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backend.ps1 start
#   ... stop | restart | status
[CmdletBinding()]
param(
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root 'backend'
$Python = Join-Path $Root '.venv\Scripts\python.exe'
$LogDir = Join-Path $Backend 'logs'
$PidFile = Join-Path $Backend '.backend.pid'
$Port = 8000
$HealthUrl = "http://127.0.0.1:$Port/api/health"

function Get-Health {
  try { return Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2 } catch { return $null }
}

function Get-PortOwner {
  try {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
      Select-Object -First 1
    return [int]$c.OwningProcess
  } catch {
    return $null
  }
}

function Test-IsOurUvicorn([int]$ProcId) {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId"
    if (-not $p -or -not $p.CommandLine) { return $false }
    return ($p.CommandLine -match 'uvicorn' -and $p.CommandLine -match 'app:app')
  } catch {
    return $false
  }
}

function Start-Backend {
  $health = Get-Health
  if ($health -and $health.status -eq 'ok') {
    Write-Host "[backend] already running on port $Port (model_loaded=$($health.model_loaded))."
    return
  }

  $owner = Get-PortOwner
  if ($owner) {
    Write-Host "[backend] port $Port is used by PID $owner (not a healthy managed uvicorn). Aborting." -ForegroundColor Yellow
    exit 1
  }

  if (-not (Test-Path $Python)) {
    Write-Host "[backend] venv python not found: $Python" -ForegroundColor Red
    exit 1
  }

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $outLog = Join-Path $LogDir 'backend.log'
  $errLog = Join-Path $LogDir 'backend.err.log'

  Write-Host "[backend] starting uvicorn on 0.0.0.0:$Port ..."
  $proc = Start-Process -FilePath $Python `
    -ArgumentList @('-m', 'uvicorn', 'app:app', '--host', '0.0.0.0', '--port', "$Port") `
    -WorkingDirectory $Backend `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden `
    -PassThru

  Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii

  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 1000
    if ($proc.HasExited) {
      Write-Host "[backend] process exited with code $($proc.ExitCode). See $errLog" -ForegroundColor Red
      Remove-Item $PidFile -ErrorAction SilentlyContinue
      exit 1
    }
    $h = Get-Health
    if ($h -and $h.status -eq 'ok') {
      Write-Host "[backend] ready on port $Port (PID $($proc.Id), model_loaded=$($h.model_loaded), device=$($h.device))."
      Write-Host "[backend] log: $outLog"
      return
    }
  }

  Write-Host "[backend] process started (PID $($proc.Id)) but health check timed out. See $errLog" -ForegroundColor Yellow
}

function Stop-Backend {
  $stopped = $false

  if (Test-Path $PidFile) {
    $savedId = [int](Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($savedId -and (Get-Process -Id $savedId -ErrorAction SilentlyContinue)) {
      Stop-Process -Id $savedId -Force
      $stopped = $true
      Write-Host "[backend] stopped PID $savedId."
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
  }

  $owner = Get-PortOwner
  if ($owner -and (Test-IsOurUvicorn $owner)) {
    Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
    $stopped = $true
    Write-Host "[backend] stopped PID $owner (port $Port)."
  }

  if (-not $stopped) {
    Write-Host "[backend] not running."
    return
  }

  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 300
    if (-not (Get-PortOwner)) { break }
  }
  if (Get-PortOwner) {
    Write-Host "[backend] port $Port is still in use." -ForegroundColor Yellow
  } else {
    Write-Host "[backend] port $Port released."
  }
}

function Show-Status {
  $health = Get-Health
  $owner = Get-PortOwner
  if ($health -and $health.status -eq 'ok') {
    Write-Host "[backend] running on port $Port (PID $owner, model_loaded=$($health.model_loaded), device=$($health.device))."
  } elseif ($owner) {
    Write-Host "[backend] port $Port is in use by PID $owner, health check failed." -ForegroundColor Yellow
  } else {
    Write-Host "[backend] not running."
  }
}

switch ($Action) {
  'start' { Start-Backend }
  'stop' { Stop-Backend }
  'restart' { Stop-Backend; Start-Backend }
  'status' { Show-Status }
}
