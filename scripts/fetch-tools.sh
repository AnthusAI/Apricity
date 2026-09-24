#!/bin/sh
# Fetch build tools into .tools/ (gitignored): wasi-sdk for compiling Rubber Band to WebAssembly.
set -eu
cd "$(dirname "$0")/.."
VER=34
ARCH=$(uname -m | sed 's/aarch64/arm64/')
OS=$(uname -s | tr '[:upper:]' '[:lower:]' | sed 's/darwin/macos/')
DIR=".tools/wasi-sdk-$VER.0-$ARCH-$OS"
if [ -d "$DIR" ]; then echo "already have $DIR"; exit 0; fi
mkdir -p .tools
curl -sL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$VER/wasi-sdk-$VER.0-$ARCH-$OS.tar.gz" | tar xz -C .tools
echo "installed $DIR"
