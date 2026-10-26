# One-time secret setup for the PFE companion (run it yourself, from the project folder):
#   powershell -ExecutionPolicy Bypass -File scripts\setup-secrets.ps1
#
# What it does (no secret is ever written to the repository):
#   1. GitHub secret GEMINI_API_KEY        <- GEMINI_API_KEY from .env (free AI agents)
#   2. GitHub secret DB_BACKUP_PASSPHRASE  <- generated once, kept in .env (encrypted DB backup)
#   3. Worker secret TELEGRAM_WEBHOOK_SECRET <- generated, then the Telegram webhook is re-registered
#   4. Starts the daily pipeline once so the agents run right away.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Read-DotEnv([string]$path) {
    $values = @{}
    if (Test-Path $path) {
        foreach ($line in Get-Content -Encoding UTF8 $path) {
            $trimmed = $line.Trim()
            if ($trimmed -and -not $trimmed.StartsWith("#") -and $trimmed.Contains("=")) {
                $parts = $trimmed.Split("=", 2)
                $values[$parts[0].Trim()] = $parts[1].Trim().Trim('"').Trim("'")
            }
        }
    }
    return $values
}

function New-RandomSecret([int]$length = 48) {
    $alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    $bytes = New-Object byte[] $length
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

Write-Host "== PFE companion: secret setup ==" -ForegroundColor Cyan
$envPath = Join-Path $root ".env"
$dotenv = Read-DotEnv $envPath

foreach ($tool in @("gh", "npx")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is not installed or not on PATH."
    }
}

# 1. Gemini key for the AI agents
if (-not $dotenv["GEMINI_API_KEY"]) {
    throw "GEMINI_API_KEY is missing from .env (get a free key at https://aistudio.google.com/apikey)."
}
gh secret set GEMINI_API_KEY --body $dotenv["GEMINI_API_KEY"]
Write-Host "[1/4] GEMINI_API_KEY saved in GitHub secrets." -ForegroundColor Green

# 2. Passphrase of the encrypted database backup (kept locally for recovery)
$passphrase = $dotenv["DB_BACKUP_PASSPHRASE"]
if (-not $passphrase) {
    $passphrase = New-RandomSecret 48
    Add-Content -Encoding UTF8 -Path $envPath -Value "`r`n# Encrypted backup of the research database (branch research-db)`r`nDB_BACKUP_PASSPHRASE=$passphrase"
}
gh secret set DB_BACKUP_PASSPHRASE --body $passphrase
Write-Host "[2/4] DB_BACKUP_PASSPHRASE saved in GitHub secrets (copy kept in .env)." -ForegroundColor Green

# 3. Private webhook secret for the Telegram bot, then re-register the webhook
$webhookSecret = New-RandomSecret 48
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pfe-secret-" + [guid]::NewGuid().ToString() + ".json")
try {
    [System.IO.File]::WriteAllText($tmp, (@{ TELEGRAM_WEBHOOK_SECRET = $webhookSecret } | ConvertTo-Json -Compress))
    Push-Location (Join-Path $root "worker")
    try {
        npx --yes wrangler secret bulk $tmp
        if ($LASTEXITCODE -ne 0) { throw "wrangler secret bulk failed" }
    } finally {
        Pop-Location
    }
} finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp
}
Start-Sleep -Seconds 8
$pairing = $dotenv["TELEGRAM_PAIRING_CODE"]
$setupUrl = "https://pfe-hla-bot.massiresacko97.workers.dev/setup?key=" + [uri]::EscapeDataString($pairing)
$result = Invoke-RestMethod -Uri $setupUrl -Method Get
if (-not $result.ok) { throw "Webhook re-registration failed." }
Write-Host "[3/4] Telegram webhook protected by a private secret ($($result.commands) commands in the menu)." -ForegroundColor Green

# 4. Run the pipeline once now
gh workflow run daily.yml
Write-Host "[4/4] Pipeline started: https://github.com/mvsss97/pfe-hla/actions" -ForegroundColor Green
Write-Host "Done. The bot will message you when the agents finish (about 10-20 minutes)." -ForegroundColor Cyan
