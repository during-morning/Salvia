#!/bin/sh
# Salvia installer for Linux and macOS:
#   curl -fsSL https://raw.githubusercontent.com/during-morning/Salvia/main/install.sh | sh
# Installs the latest release's `salvia` into ~/.local/bin (override with SALVIA_INSTALL_DIR);
# SALVIA_VERSION=0.1.0 picks a release.
set -eu

REPO="during-morning/Salvia"
DIR="${SALVIA_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) echo "Salvia: unsupported system $(uname -s); on Windows use install.ps1" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "Salvia: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$@"; else wget -qO- "$@"; fi
}

version="${SALVIA_VERSION:-}"
if [ -z "$version" ]; then
  version="$(fetch "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
fi
[ -n "$version" ] || { echo "Salvia: could not find the latest release" >&2; exit 1; }

name="salvia-$version-$os-$arch"
url="https://github.com/$REPO/releases/download/v$version/$name.tar.gz"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading Salvia $version ($os-$arch)…"
fetch "$url" > "$tmp/salvia.tar.gz"
tar -xzf "$tmp/salvia.tar.gz" -C "$tmp"
mkdir -p "$DIR"
install -m 755 "$tmp/$name/salvia" "$DIR/salvia"

echo "Installed $DIR/salvia"
case ":$PATH:" in
  *":$DIR:"*) echo "Run: salvia" ;;
  *) echo "Add it to your PATH, e.g.:  echo 'export PATH=\"$DIR:\$PATH\"' >> ~/.profile" ;;
esac
