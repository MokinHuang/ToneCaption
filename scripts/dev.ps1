# Start/stop ToneCaption frontend + backend with one command.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev.ps1 start
#   ... stop | restart | status
[CmdletBinding()]
param(
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'

$Frontend = Join-Path $PSScriptRoot 'frontend.ps1'
$BackendScript = Join-Path $PSScriptRoot 'backend.ps1'

switch ($Action) {
  'start' {
    & $Frontend start
    & $BackendScript start
    Write-Host "[dev] open http://localhost:5173/#/classroom"
  }
  'stop' {
    & $Frontend stop
    & $BackendScript stop
  }
  'restart' {
    & $Frontend stop
    & $BackendScript stop
    & $Frontend start
    & $BackendScript start
    Write-Host "[dev] open http://localhost:5173/#/classroom"
  }
  'status' {
    & $Frontend status
    & $BackendScript status
  }
}
