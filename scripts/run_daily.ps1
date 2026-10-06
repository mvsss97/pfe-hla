[CmdletBinding()]
param(
    [switch]$SkipCollection,
    [switch]$SkipTelegram
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $python)) {
    Write-Error 'Virtual environment missing. Run scripts\bootstrap.ps1 first.'
}

Push-Location $projectRoot
try {
    & $python -m pfe_hla init --seed
    if (-not $SkipCollection) {
        & $python -m pfe_hla collect --limit 20
        if ($LASTEXITCODE -ne 0) {
            Write-Warning 'At least one scholarly source failed; successful runs were retained.'
        }
    }
    & $python -m pfe_hla export
    if (-not $SkipTelegram) {
        & $python -m pfe_hla digest
    }
}
finally {
    Pop-Location
}

