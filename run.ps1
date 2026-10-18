<#
.SYNOPSIS
  Starts the whole SkyRoute Warsaw application (FastAPI backend + Angular frontend).

.DESCRIPTION
  Local mode (default): creates the Python venv and installs the npm packages when they are
  missing or out of date, starts the backend on http://localhost:8000 and the frontend on
  http://localhost:4200, waits until both answer, then opens the browser. Ctrl+C stops both.
  Logs go to .\logs\.

.EXAMPLE
  .\run.ps1              # run locally
.EXAMPLE
  .\run.ps1 -Docker      # build and start the Docker containers instead
.EXAMPLE
  .\run.ps1 -Down        # stop and remove the Docker containers
#>
param(
    [switch]$Docker,      # use Docker Compose instead of local Python/Node
    [switch]$Down,        # docker compose down
    [switch]$NoBrowser    # do not open the browser
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Backend = Join-Path $Root 'backend'
$Frontend = Join-Path $Root 'frontend'
$Logs = Join-Path $Root 'logs'
$AppUrl = 'http://localhost:4200'
$HealthUrl = 'http://localhost:8000/api/v1/health'

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Fail([string]$Text) { Write-Host "ERROR: $Text" -ForegroundColor Red; exit 1 }

function Test-Url([string]$Url) {
    try { $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3; return $true } catch { return $false }
}

function Wait-Url([string]$Url, [int]$Seconds, [string]$Name, $Process, [string]$Log) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Url $Url) { return }
        if ($Process -and $Process.HasExited) {
            if ($Log -and (Test-Path $Log)) { Get-Content $Log -Tail 25 | Write-Host }
            Fail "$Name stopped while starting (see $Log)."
        }
        Start-Sleep -Seconds 2
    }
    Fail "$Name did not answer at $Url within $Seconds s (see $Log)."
}

function Assert-PortFree([int]$Port, [string]$Name) {
    $client = New-Object System.Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', $Port); $busy = $true } catch { $busy = $false } finally { $client.Close() }
    if (-not $busy) { return }
    $owner = ''
    try {
        $procId = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess
        $owner = " by $((Get-Process -Id $procId).ProcessName) (PID $procId)"
    } catch { }
    Fail "Port $Port ($Name) is already in use$owner. Stop that program first; the app needs ports 8000 and 4200."
}

function Get-FileHashText([string]$Path) { (Get-FileHash -Algorithm SHA256 -Path $Path).Hash }

function Stop-Tree($Process) {
    if ($Process -and -not $Process.HasExited) {
        & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null   # also stops child node/python processes
    }
}

# ------------------------------------------------------------------ Docker
function Start-DockerEngine {
    try { & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { return } } catch { }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker is not installed (https://www.docker.com/products/docker-desktop/).' }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
    )
    $exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $exe) { Fail 'The Docker engine is not running. Start Docker Desktop and try again.' }
    Write-Step 'Starting Docker Desktop'
    Start-Process $exe | Out-Null
    $deadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $deadline) {
        & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Seconds 3
    }
    Fail 'Docker Desktop did not start within 3 minutes.'
}

if ($Down) {
    Push-Location $Root
    try { Write-Step 'Stopping the Docker containers'; & docker compose down } finally { Pop-Location }
    exit $LASTEXITCODE
}

if ($Docker) {
    Start-DockerEngine
    Push-Location $Root
    try {
        Assert-PortFree 8000 'backend'
        Assert-PortFree 4200 'frontend'
        Write-Step 'Building the images (first time takes a few minutes)'
        & docker compose build
        if ($LASTEXITCODE -ne 0) { Fail 'docker compose build failed.' }
        Write-Step 'Starting the containers'
        & docker compose up -d
        if ($LASTEXITCODE -ne 0) { Fail 'docker compose up failed.' }
    } finally { Pop-Location }
    Wait-Url $AppUrl 180 'Frontend' $null 'docker compose logs'
    Write-Host ''
    Write-Host "SkyRoute Warsaw is running: $AppUrl  (API docs: http://localhost:8000/docs)" -ForegroundColor Green
    Write-Host 'Stop it with: .\run.ps1 -Down   (or: docker compose down)'
    if (-not $NoBrowser) { Start-Process $AppUrl }
    exit 0
}

# ------------------------------------------------------------------ Local
Write-Step 'Checking Python and Node'
$python = $null
foreach ($candidate in @(@('py', '-3.12'), @('py', '-3'), @('python'))) {
    $exe = $candidate[0]
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
    $pyArgs = @($candidate | Select-Object -Skip 1)
    $ok = & $exe @pyArgs -c 'import sys; print(sys.version_info >= (3, 12))' 2>$null
    if ($ok -eq 'True') { $python = $candidate; break }
}
if (-not $python) { Fail 'Python 3.12 or newer is required (https://www.python.org/downloads/).' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'Node.js 20 or newer is required (https://nodejs.org/).' }

Assert-PortFree 8000 'backend'
Assert-PortFree 4200 'frontend'
New-Item -ItemType Directory -Force $Logs | Out-Null

# Backend dependencies: (re)install only when requirements.txt changed.
$venvPython = Join-Path $Backend '.venv\Scripts\python.exe'
$reqFile = Join-Path $Backend 'requirements.txt'
$reqStamp = Join-Path $Backend '.venv\.requirements.sha256'
if (-not (Test-Path $venvPython)) {
    Write-Step 'Creating the Python virtual environment (backend\.venv)'
    $pyArgs = @($python | Select-Object -Skip 1) + @('-m', 'venv', (Join-Path $Backend '.venv'))
    & $python[0] @pyArgs
    if ($LASTEXITCODE -ne 0) { Fail 'Could not create the virtual environment.' }
}
$reqHash = Get-FileHashText $reqFile
if (-not (Test-Path $reqStamp) -or (Get-Content $reqStamp -Raw).Trim() -ne $reqHash) {
    Write-Step 'Installing backend packages'
    & $venvPython -m pip install --disable-pip-version-check -q -r $reqFile
    if ($LASTEXITCODE -ne 0) { Fail 'pip install failed.' }
    Set-Content -Path $reqStamp -Value $reqHash -Encoding ascii
}

# Frontend dependencies: (re)install only when package-lock.json changed.
$lockFile = Join-Path $Frontend 'package-lock.json'
$lockStamp = Join-Path $Frontend 'node_modules\.package-lock.sha256'
$lockHash = Get-FileHashText $lockFile
if (-not (Test-Path (Join-Path $Frontend 'node_modules')) -or -not (Test-Path $lockStamp) -or
        (Get-Content $lockStamp -Raw).Trim() -ne $lockHash) {
    Write-Step 'Installing frontend packages (npm ci)'
    Push-Location $Frontend
    try { & npm ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed.' } } finally { Pop-Location }
    Set-Content -Path $lockStamp -Value $lockHash -Encoding ascii
}

$backendLog = Join-Path $Logs 'backend.log'
$frontendLog = Join-Path $Logs 'frontend.log'
$backendProc = $null
$frontendProc = $null
try {
    Write-Step 'Starting the backend on http://localhost:8000'
    $backendProc = Start-Process -FilePath $venvPython -WorkingDirectory $Backend -PassThru -WindowStyle Hidden `
        -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--port', '8000') `
        -RedirectStandardOutput $backendLog -RedirectStandardError "$backendLog.err"
    Wait-Url $HealthUrl 120 'Backend' $backendProc "$backendLog.err"

    Write-Step 'Starting the frontend on http://localhost:4200 (first build takes ~20 s)'
    $frontendProc = Start-Process -FilePath 'npx.cmd' -WorkingDirectory $Frontend -PassThru -WindowStyle Hidden `
        -ArgumentList @('ng', 'serve', '--port', '4200') `
        -RedirectStandardOutput $frontendLog -RedirectStandardError "$frontendLog.err"
    Wait-Url $AppUrl 180 'Frontend' $frontendProc $frontendLog

    Write-Host ''
    Write-Host "SkyRoute Warsaw is running: $AppUrl  (API docs: http://localhost:8000/docs)" -ForegroundColor Green
    Write-Host "Logs: $Logs   Press Ctrl+C to stop both servers."
    if (-not $NoBrowser) { Start-Process $AppUrl }

    while (-not $backendProc.HasExited -and -not $frontendProc.HasExited) { Start-Sleep -Seconds 2 }
    if ($backendProc.HasExited) { Write-Host "The backend stopped; see $backendLog.err" -ForegroundColor Yellow }
    if ($frontendProc.HasExited) { Write-Host "The frontend stopped; see $frontendLog" -ForegroundColor Yellow }
}
finally {
    Write-Step 'Stopping the servers'
    Stop-Tree $frontendProc
    Stop-Tree $backendProc
}
