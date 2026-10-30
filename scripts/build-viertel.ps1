# Baut Viertel als EINE Datei (dist-single\Viertel.html) zum Ablegen in SharePoint.
#
# Gebaut wird in einer Kopie außerhalb von OneDrive (%LOCALAPPDATA%\viertel-build),
# damit die tausenden Hilfsdateien von npm nicht synchronisiert werden. Node.js
# liegt dort portabel unter node\ (keine Installation, keine Admin-Rechte).
#
# Aufruf (im Projektordner):   powershell -ExecutionPolicy Bypass -File scripts\build-viertel.ps1

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$build   = Join-Path $env:LOCALAPPDATA 'viertel-build'
$node    = Join-Path $build 'node'
$app     = Join-Path $build 'app'

if (-not (Test-Path (Join-Path $node 'node.exe'))) {
  Write-Host "Node.js fehlt unter $node — bitte portable Version von nodejs.org dorthin entpacken." -ForegroundColor Red
  exit 1
}
$env:PATH = "$node;$env:PATH"

# 1. Projekt in die Build-Kopie spiegeln (ohne Git, Abhängigkeiten, Ergebnisse)
New-Item -ItemType Directory -Force $app | Out-Null
robocopy $project $app /MIR /XD .git .claude node_modules dist dist-single /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Kopieren fehlgeschlagen (robocopy $LASTEXITCODE)" }

# 2. Abhängigkeiten nur installieren, wenn sich package-lock.json geändert hat
Push-Location $app
try {
  $lock = (Get-FileHash package-lock.json).Hash
  $stamp = Join-Path $build 'lock.hash'
  if (-not (Test-Path node_modules) -or -not (Test-Path $stamp) -or (Get-Content $stamp) -ne $lock) {
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci fehlgeschlagen' }
    Set-Content $stamp $lock
  }
  # 3. Bauen
  npm run build:single
  if ($LASTEXITCODE -ne 0) { throw 'Build fehlgeschlagen' }
} finally { Pop-Location }

# 4. Ergebnis zurück ins Projekt
$out = Join-Path $project 'dist-single'
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $app 'dist-single\Viertel.html') $out -Force
$f = Get-Item (Join-Path $out 'Viertel.html')
Write-Host ("Fertig: {0}  ({1:N0} KB)" -f $f.FullName, ($f.Length / 1KB)) -ForegroundColor Green
