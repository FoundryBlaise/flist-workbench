# Pulls latest dev and rebuilds the portable Windows .exe.
# Run from anywhere: powershell -File build-win.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo

Write-Host "==> git pull --ff-only origin dev" -ForegroundColor Cyan
git pull --ff-only origin dev
if ($LASTEXITCODE -ne 0) { throw "git pull failed" }

# The sidecar venv is uv-managed and PyInstaller lives in its dev group.
# Sync here so the venv always has pyinstaller.exe before pack:sidecar
# runs — a bare `uv sync` elsewhere would otherwise wipe it.
Write-Host "==> uv sync (sidecar)" -ForegroundColor Cyan
uv sync --project sidecar
if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }

# Mirror uv sync for the Node side. `npm ci` is the reproducible-install
# counterpart: it wipes node_modules, installs from the lockfile, and
# fires the postinstall hook that rebuilds native modules (keytar) for
# the bundled Electron version. Skipping this after a dev pull that
# adds a native dep will leave you with a runtime DLL-load error in
# the packaged build, not a build-time failure — so it matters.
Write-Host "==> npm ci (renderer + main)" -ForegroundColor Cyan
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

Write-Host "==> npm run pack:win" -ForegroundColor Cyan
npm run pack:win
if ($LASTEXITCODE -ne 0) { throw "npm run pack:win failed (exit $LASTEXITCODE)" }

# Derive the artifact name from package.json so a version bump doesn't
# strand this check on a stale filename.
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$exe = Join-Path $repo "dist-electron\F-list Workbench-$version-x64-portable.exe"
if (Test-Path $exe) {
  $size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
  Write-Host "==> Built: $exe ($size MB)" -ForegroundColor Green
} else {
  Write-Host "==> Build finished but expected artifact not found" -ForegroundColor Yellow
  exit 1
}
