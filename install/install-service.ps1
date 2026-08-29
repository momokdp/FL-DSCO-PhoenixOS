# =====================================================================
#  Installe la console Kadesh comme service Windows via NSSM.
#  À lancer depuis une invite PowerShell ouverte en administrateur :
#      .\install\install-service.ps1
# =====================================================================

#Requires -RunAsAdministrator

param(
    [string]$ServiceName = "KadeshConsole",
    [string]$NssmPath    = "C:\nssm\nssm.exe"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

Write-Host ""
Write-Host "  Installation du service $ServiceName" -ForegroundColor Cyan
Write-Host "  Projet : $projectRoot"
Write-Host ""

# --- Vérifications préalables ---------------------------------------

if (-not (Test-Path $NssmPath)) {
    Write-Host "NSSM est introuvable a l'emplacement $NssmPath." -ForegroundColor Red
    Write-Host "Telechargez-le sur https://nssm.cc/download, decompressez-le,"
    Write-Host "puis relancez ce script avec -NssmPath <chemin vers nssm.exe>."
    exit 1
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-Host "Node.js est introuvable dans le PATH." -ForegroundColor Red
    Write-Host "Installez la version LTS depuis https://nodejs.org puis rouvrez PowerShell."
    exit 1
}

$nodeVersion = (& node --version).TrimStart('v').Split('.')[0]
if ([int]$nodeVersion -lt 20) {
    Write-Host "Node.js $nodeVersion detecte. La version 20 ou superieure est requise." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path (Join-Path $projectRoot ".env"))) {
    Write-Host "Le fichier .env est absent." -ForegroundColor Red
    Write-Host "Copiez .env.example en .env et renseignez-le avant d'installer le service."
    exit 1
}

if (-not (Test-Path (Join-Path $projectRoot "node_modules"))) {
    Write-Host "Installation des dependances npm..." -ForegroundColor Yellow
    Push-Location $projectRoot
    & npm install --omit=dev
    Pop-Location
}

# --- Dossiers de travail --------------------------------------------

foreach ($dir in @("data", "logs")) {
    $path = Join-Path $projectRoot $dir
    if (-not (Test-Path $path)) { New-Item -ItemType Directory -Path $path | Out-Null }
}

# --- Remplacement d'une installation precedente ----------------------

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Le service existe deja : arret et suppression." -ForegroundColor Yellow
    & $NssmPath stop   $ServiceName confirm | Out-Null
    & $NssmPath remove $ServiceName confirm | Out-Null
    Start-Sleep -Seconds 2
}

# --- Creation du service --------------------------------------------

& $NssmPath install $ServiceName $node "src\server.js"                       | Out-Null
& $NssmPath set $ServiceName AppDirectory      $projectRoot                  | Out-Null
& $NssmPath set $ServiceName DisplayName       "Console logistique Kadesh"   | Out-Null
& $NssmPath set $ServiceName Description       "Suivi des soutes, missions et recettes des bases joueur." | Out-Null
& $NssmPath set $ServiceName Start             SERVICE_AUTO_START            | Out-Null
& $NssmPath set $ServiceName AppEnvironmentExtra "NODE_ENV=production"       | Out-Null

# Journaux tournants : 10 Mo par fichier, pour ne pas saturer le disque.
& $NssmPath set $ServiceName AppStdout        (Join-Path $projectRoot "logs\console.log") | Out-Null
& $NssmPath set $ServiceName AppStderr        (Join-Path $projectRoot "logs\erreurs.log") | Out-Null
& $NssmPath set $ServiceName AppRotateFiles   1        | Out-Null
& $NssmPath set $ServiceName AppRotateBytes   10485760 | Out-Null

# Redemarrage automatique, avec temporisation croissante en cas de boucle d'echec.
& $NssmPath set $ServiceName AppExit Default Restart | Out-Null
& $NssmPath set $ServiceName AppRestartDelay 5000    | Out-Null

Write-Host "Demarrage du service..." -ForegroundColor Yellow
& $NssmPath start $ServiceName | Out-Null
Start-Sleep -Seconds 3

$svc = Get-Service -Name $ServiceName
Write-Host ""
if ($svc.Status -eq "Running") {
    Write-Host "  Service demarre." -ForegroundColor Green
    Write-Host "  Verification : http://localhost:3000/healthz"
} else {
    Write-Host "  Le service n'a pas demarre (etat : $($svc.Status))." -ForegroundColor Red
    Write-Host "  Consultez logs\erreurs.log pour en connaitre la cause."
}
Write-Host ""
Write-Host "  Commandes utiles :"
Write-Host "    $NssmPath restart $ServiceName"
Write-Host "    $NssmPath stop    $ServiceName"
Write-Host "    Get-Content logs\console.log -Wait -Tail 40"
Write-Host ""
