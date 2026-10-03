$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

# Each step checks the exit code of the previous command (P1-16 / L-25): stop at the first failure instead of continuing.
function Invoke-Step([string]$title, [scriptblock]$action) {
  Write-Host $title -ForegroundColor Yellow
  & $action
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed: $title (exit code $LASTEXITCODE). Fix the problem above and run this script again." -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

Write-Host "== Agent Control Center first run ==" -ForegroundColor Cyan

if (-not (Test-Path .\node_modules)) {
  Invoke-Step "Installing dependencies..." { npm install }
}
Invoke-Step "Checking the environment..." { node .\scripts\doctor.mjs }
Invoke-Step "Running typecheck..." { npm run typecheck }
Invoke-Step "Running tests..." { npm test }

Write-Host "Starting Agent Control Center (real mode, the browser opens automatically)..." -ForegroundColor Green
npm run start:real
