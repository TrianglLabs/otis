# Install Otis on Windows.
#
# Usage:
#   irm https://github.com/triangllabs/otis/releases/latest/download/install.ps1 | iex
#   & ([scriptblock]::Create((irm .../install.ps1))) -InstallDir "$env:LOCALAPPDATA\Programs\otis"
#
# Options:
#   -InstallDir DIR   Install otis.exe into DIR. Defaults to %LOCALAPPDATA%\Programs\otis.
#   -Version VERSION  Install a specific version, for example 0.2.31.
#   -BaseUrl URL      GitHub Releases base URL. Defaults to the Otis repository.
#
# OTIS_INSTALL_DIR and OTIS_INSTALL_BASE_URL set the same defaults as for install.sh.
param(
  [string]$InstallDir = $(if ($env:OTIS_INSTALL_DIR) { $env:OTIS_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\otis" }),
  [string]$Version = "",
  [string]$BaseUrl = $(if ($env:OTIS_INSTALL_BASE_URL) { $env:OTIS_INSTALL_BASE_URL } else { "https://github.com/triangllabs/otis/releases" })
)

$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 negotiates TLS 1.0 by default; GitHub requires 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$BaseUrl = $BaseUrl.TrimEnd("/")

# A 32-bit PowerShell on a 64-bit Windows reports the emulated architecture in PROCESSOR_ARCHITECTURE.
$machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($machine -ne "AMD64" -and $machine -ne "ARM64") {
  throw "Unsupported CPU architecture: $machine"
}
# The release ships one Windows build, for x64; Windows on Arm runs it through its x64 emulation.
$target = "windows-x64"

if (-not $Version) {
  $Version = (Invoke-RestMethod -Uri "$BaseUrl/latest/download/latest.txt" -UseBasicParsing).Trim()
}
$Version = $Version.TrimStart("v")
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Invalid Otis version: $Version"
}

$artifact = "otis-$target.zip"
$releaseUrl = "$BaseUrl/download/v$Version"
$tmpDir = Join-Path ([IO.Path]::GetTempPath()) ("otis-install-" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmpDir | Out-Null
try {
  Write-Host "Installing Otis v$Version for $target..."
  $archive = Join-Path $tmpDir $artifact
  Invoke-WebRequest -Uri "$releaseUrl/$artifact" -OutFile $archive -UseBasicParsing
  $checksums = (Invoke-RestMethod -Uri "$releaseUrl/checksums.txt" -UseBasicParsing) -split "`n"
  $expected = $null
  foreach ($line in $checksums) {
    $fields = $line.Trim() -split "\s+"
    if ($fields.Length -eq 2 -and $fields[1] -eq $artifact) { $expected = $fields[0] }
  }
  if (-not $expected) {
    throw "Checksum for $artifact was not found."
  }
  $actual = (Get-FileHash -Path $archive -Algorithm SHA256).Hash
  if ($actual -ne $expected.ToUpperInvariant()) {
    throw "Checksum verification failed for $artifact."
  }

  $extracted = Join-Path $tmpDir "extract"
  Expand-Archive -Path $archive -DestinationPath $extracted
  $entries = @(Get-ChildItem -Path $extracted -Recurse -Force)
  if ($entries.Count -ne 1 -or $entries[0].Name -ne "otis.exe" -or $entries[0].PSIsContainer) {
    throw "Otis release archive must contain only otis.exe."
  }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $destination = Join-Path $InstallDir "otis.exe"
  # A running otis.exe cannot be overwritten, but it can be moved aside; the next install removes
  # the leftover once that process has exited.
  $previous = Join-Path $InstallDir ".otis-previous.exe"
  Remove-Item -Path $previous -Force -ErrorAction SilentlyContinue
  if (Test-Path -Path $destination) {
    Move-Item -Path $destination -Destination $previous -Force
  }
  Copy-Item -Path $entries[0].FullName -Destination $destination
  Remove-Item -Path $previous -Force -ErrorAction SilentlyContinue
  Write-Host "Otis installed to $destination"
} finally {
  Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Like install.sh, the PATH is the user's: say what to run rather than editing the registry.
$onPath = ($env:Path -split ";" | Where-Object { $_ } | ForEach-Object { $_.TrimEnd("\") }) -contains $InstallDir.TrimEnd("\")
if (-not $onPath) {
  Write-Host ""
  Write-Host "Add Otis to your PATH, then open a new terminal:"
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"$InstallDir;`" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
}

$existing = Get-Command otis -ErrorAction SilentlyContinue | Where-Object { $_.Source -and $_.Source -ne (Join-Path $InstallDir "otis.exe") } | Select-Object -First 1
if ($existing) {
  Write-Host ""
  Write-Host "Note: another otis executable is earlier on PATH: $($existing.Source)"
  Write-Host "Put $InstallDir before it on PATH, or remove the old install."
}
