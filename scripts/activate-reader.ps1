# Instant translation in the PDF reader: gives the bot (Cloudflare worker) the
# free Gemini key stored in .env. Double-click ACTIVER-LECTEUR.bat to run it.
# Without it the reader still works: the agents translate papers ahead of time.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$key = $null
foreach ($line in Get-Content -Encoding UTF8 (Join-Path $root ".env")) {
    if ($line.Trim().StartsWith("GEMINI_API_KEY=")) { $key = $line.Trim().Substring(15).Trim().Trim('"').Trim("'") }
}
if (-not $key) { throw "GEMINI_API_KEY est absent du fichier .env." }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pfe-reader-" + [guid]::NewGuid().ToString() + ".json")
try {
    [System.IO.File]::WriteAllText($tmp, (@{ GEMINI_API_KEY = $key } | ConvertTo-Json -Compress))
    Push-Location (Join-Path $root "worker")
    try {
        npx --yes wrangler secret bulk $tmp
        if ($LASTEXITCODE -ne 0) { throw "wrangler secret bulk a échoué (connecte-toi d'abord : npx wrangler login)." }
    } finally {
        Pop-Location
    }
} finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp
}
Write-Host ""
Write-Host "C'est fait : le lecteur traduit maintenant n'importe quel PDF instantanément." -ForegroundColor Green
