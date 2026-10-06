# Salvia installer for Windows:
#   irm https://raw.githubusercontent.com/during-morning/Salvia/main/install.ps1 | iex
# Installs the latest release into %LOCALAPPDATA%\Programs\Salvia and puts it on your PATH.
# $env:SALVIA_VERSION = '0.1.0' picks a release.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'during-morning/Salvia'
$dir = Join-Path $env:LOCALAPPDATA 'Programs\Salvia'

$version = $env:SALVIA_VERSION
if (-not $version) {
  $version = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name -replace '^v', ''
}

$name = "salvia-$version-windows-x64"
$url = "https://github.com/$repo/releases/download/v$version/$name.zip"
$tmp = Join-Path ([IO.Path]::GetTempPath()) "salvia-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Force $tmp | Out-Null

try {
  Write-Host "Downloading Salvia $version..."
  Invoke-WebRequest $url -OutFile (Join-Path $tmp 'salvia.zip') -UseBasicParsing
  Expand-Archive (Join-Path $tmp 'salvia.zip') $tmp -Force
  New-Item -ItemType Directory -Force $dir | Out-Null
  Copy-Item (Join-Path $tmp "$name\*") $dir -Recurse -Force
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($path -split ';') -notcontains $dir) {
  [Environment]::SetEnvironmentVariable('Path', (($path.TrimEnd(';'), $dir) -join ';').TrimStart(';'), 'User')
  $env:Path = "$env:Path;$dir"
}

Write-Host "Installed $dir\salvia.exe"
Write-Host 'Run: salvia   (open a new terminal if the command is not found)'
