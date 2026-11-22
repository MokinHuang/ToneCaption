# Frontend control for ToneCaption (Vite dev server on port 5173).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\frontend.ps1 start
#   ... stop | restart | status
[CmdletBinding()]
param(
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
$PidFile = Join-Path $Root '.frontend.pid'
$Port = 5173
$Url = "http://127.0.0.1:$Port/"

function Test-Up {
  try {
    $r = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
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

function Test-IsOurVite([int]$ProcId) {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId"
    if (-not $p -or -not $p.CommandLine) { return $false }
    return ($p.CommandLine -match 'vite')
  } catch {
    return $false
  }
}

function Start-Frontend {
  if (Test-Up) {
    Write-Host "[frontend] already running on http://127.0.0.1:$Port/"
    return
  }

  $owner = Get-PortOwner
  if ($owner) {
    if (Test-IsOurVite $owner) {
      Write-Host "[frontend] port $Port is held by a stale vite process (PID $owner). Run stop first." -ForegroundColor Yellow
    } else {
      Write-Host "[frontend] port $Port is used by PID $owner (not vite). Aborting." -ForegroundColor Yellow
    }
    exit 1
  }

  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if (-not $npm) {
    Write-Host "[frontend] npm.cmd not found in PATH." -ForegroundColor Red
    exit 1
  }

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $outLog = Join-Path $LogDir 'frontend.log'
  $errLog = Join-Path $LogDir 'frontend.err.log'

  Write-Host "[frontend] starting vite on port $Port ..."
  $proc = Start-Process -FilePath $npm `
    -ArgumentList @('run', 'dev') `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden `
    -PassThru

  Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii

  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) {
      Write-Host "[frontend] process exited with code $($proc.ExitCode). See $errLog" -ForegroundColor Red
      Remove-Item $PidFile -ErrorAction SilentlyContinue
      exit 1
    }
    if (Test-Up) {
      Write-Host "[frontend] ready at http://localhost:$Port/ (PID $($proc.Id))."
      Write-Host "[frontend] log: $outLog"
      return
    }
  }

  Write-Host "[frontend] process started (PID $($proc.Id)) but the page did not answer in time. See $errLog" -ForegroundColor Yellow
}

function Stop-Frontend {
  $stopped = $false

  if (Test-Path $PidFile) {
    $savedId = [int](Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($savedId -and (Get-Process -Id $savedId -ErrorAction SilentlyContinue)) {
      & taskkill.exe /PID $savedId /T /F 2>$null | Out-Null
      $stopped = $true
      Write-Host "[frontend] stopped PID $savedId (process tree)."
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
  }

  $owner = Get-PortOwner
  if ($owner -and (Test-IsOurVite $owner)) {
    Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
    $stopped = $true
    Write-Host "[frontend] stopped vite PID $owner (port $Port)."
  }

  if (-not $stopped) {
    Write-Host "[frontend] not running."
    return
  }

  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 300
    if (-not (Get-PortOwner)) { break }
  }
  if (Get-PortOwner) {
    Write-Host "[frontend] port $Port is still in use." -ForegroundColor Yellow
  } else {
    Write-Host "[frontend] port $Port released."
  }
}

function Show-Status {
  $owner = Get-PortOwner
  if (Test-Up) {
    Write-Host "[frontend] running at http://localhost:$Port/ (PID $owner)."
  } elseif ($owner) {
    Write-Host "[frontend] port $Port is in use by PID $owner, page did not answer." -ForegroundColor Yellow
  } else {
    Write-Host "[frontend] not running."
  }
}

switch ($Action) {
  'start' { Start-Frontend }
  'stop' { Stop-Frontend }
  'restart' { Stop-Frontend; Start-Frontend }
  'status' { Show-Status }
}
