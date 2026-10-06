[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Get-Command py -ErrorAction SilentlyContinue

if (-not $python) {
    Write-Error 'Python is missing. Install Python 3.12 first: winget install --id Python.Python.3.12 -e'
}

Push-Location $projectRoot
try {
    & py -3.12 -m venv .venv
    & .\.venv\Scripts\python.exe -m pip install --upgrade pip
    & .\.venv\Scripts\python.exe -m pip install -e '.[dev]'
    & .\.venv\Scripts\python.exe -m pfe_hla init --seed
    & .\.venv\Scripts\python.exe -m pfe_hla export
    Write-Host 'Ready. Run: .\.venv\Scripts\python.exe -m pfe_hla serve'
}
finally {
    Pop-Location
}

