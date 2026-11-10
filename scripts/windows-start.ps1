# One-click setup and start for Windows. UNVERIFIED: written without access to a Windows machine.
# Safe defaults: test mode stays ON (nothing is deleted or removed), local HTTP only.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Fail($msg) { Write-Host ""; Write-Host "ERROR: $msg" -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }

# 1. Node.js >= 22.13
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js is not installed. Install the LTS version (22 or newer) from https://nodejs.org then run this again." }
$v = [version](& node -p "process.versions.node")
if ($v -lt [version]'22.13.0') { Fail "Node.js $v is too old. Install version 22.13 or newer from https://nodejs.org" }

# 2. Chrome / Chromium for the WhatsApp worker
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Fail "Google Chrome was not found. Install Chrome from https://www.google.com/chrome then run this again." }

# 3. Install dependencies once
if (-not (Test-Path node_modules)) {
  Write-Host "Installing dependencies (first run only, takes a few minutes)..." -ForegroundColor Cyan
  $env:PUPPETEER_SKIP_DOWNLOAD = 'true'
  npm install
  if ($LASTEXITCODE -ne 0) { Fail "npm install failed. Copy the messages above and send them to Claude." }
}
if (Test-Path src\web\shims.d.ts) { Remove-Item src\web\shims.d.ts }

# 4. Build the dashboard
Write-Host "Building the dashboard..." -ForegroundColor Cyan
npm run build:web
if ($LASTEXITCODE -ne 0) { Fail "Dashboard build failed. Copy the messages above and send them to Claude." }

# 5. Create the first admin (only if there is no database yet)
if (-not (Test-Path data\guardian.db)) {
  Write-Host ""
  Write-Host "Create your dashboard login. Username will be: admin" -ForegroundColor Cyan
  do {
    $sec = Read-Host "Choose a password (at least 12 characters)" -AsSecureString
    $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  } while ($pw.Length -lt 12)
  $env:GUARDIAN_PASSWORD = $pw
  npm run create-admin -- admin
  Remove-Item Env:GUARDIAN_PASSWORD
  if ($LASTEXITCODE -ne 0) { Fail "Could not create the admin account." }
}

# 6. Start the API and the WhatsApp worker in their own windows
Write-Host "Starting the dashboard server and the WhatsApp worker..." -ForegroundColor Cyan
$dir = (Get-Location).Path
Start-Process powershell -ArgumentList '-NoExit','-Command',"Set-Location '$dir'; `$env:COOKIE_SECURE='false'; npm run start:api"
Start-Process powershell -ArgumentList '-NoExit','-Command',"Set-Location '$dir'; `$env:CHROMIUM_PATH='$chrome'; npm run start:worker"
Start-Sleep -Seconds 6
Start-Process "http://127.0.0.1:8080"

Write-Host ""
Write-Host "Done. Sign in as 'admin'. Open 'WhatsApp connection' and scan the QR with your TEST phone number only." -ForegroundColor Green
Write-Host "Test mode is ON: nothing will be deleted until you turn it off yourself." -ForegroundColor Yellow
Read-Host "Press Enter to close this window (the two server windows keep running)"
