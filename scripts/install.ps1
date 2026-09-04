<#
.SYNOPSIS
  Installs/updates the Nullshade Private Tab mod into a Firefox-based browser.

.EXAMPLE
  # Nullshade Portable (auto-detects App\Zen and Data\profile under -BrowserRoot)
  .\install.ps1 -BrowserRoot "X:\apps\Zen Browser"

  # Any other Firefox/Zen install (installed, not portable)
  .\install.ps1 -AppDir "C:\Program Files\Zen Browser" -ProfileDir "$env:APPDATA\zen\Profiles\xxxxxxxx.default"
#>
param(
    [string]$BrowserRoot,
    [string]$AppDir,
    [string]$ProfileDir
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Payload = Join-Path $Root "payload"

if ($BrowserRoot) {
    if (-not $AppDir) { $AppDir = Join-Path $BrowserRoot "App\Zen" }
    if (-not $ProfileDir) { $ProfileDir = Join-Path $BrowserRoot "Data\profile" }
}

if (-not $AppDir -or -not $ProfileDir) {
    throw "Specify either -BrowserRoot (Nullshade Portable layout) or both -AppDir and -ProfileDir (any other Firefox/Zen install)."
}
if (-not (Test-Path $AppDir)) { throw "AppDir not found: $AppDir" }
if (-not (Test-Path $ProfileDir)) { throw "ProfileDir not found: $ProfileDir (start the browser once first so Firefox creates the profile)" }

Write-Host "== Installing into:"
Write-Host "   App:     $AppDir"
Write-Host "   Profile: $ProfileDir"

Copy-Item -Recurse -Force (Join-Path $Payload "app-overlay\*") $AppDir

$ChromeDir = Join-Path $ProfileDir "chrome"
New-Item -ItemType Directory -Force $ChromeDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $Payload "profile-overlay\chrome\*") $ChromeDir

# Первая установка требует сброса startup cache, чтобы Firefox точно подхватил
# новые chrome-скрипты, а не то, что закэшировал раньше.
$StartupCache = Join-Path $ProfileDir "startupCache"
if (Test-Path $StartupCache) {
    Remove-Item -Recurse -Force $StartupCache -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Done. Close the browser fully (if it's running) and start it again."
