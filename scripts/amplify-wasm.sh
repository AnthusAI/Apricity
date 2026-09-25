#!/bin/sh
# Build web/dist's apricity_web.wasm on a clean Linux CI image (AWS Amplify Hosting), where only this
# repository is checked out. Installs a minimal Rust toolchain (per rust-toolchain.toml) and wasi-sdk
# (scripts/fetch-tools.sh), trims the workspace to the crates the browser needs
# (scripts/web-only-workspace.sh), and builds the wasm module. Everything it downloads goes under
# web/.cache so Amplify's build cache can keep it between builds.
# Usage (from anywhere): scripts/amplify-wasm.sh
# Output: web/.cache/apricity_web.wasm (copied out of the target directory).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CACHE="$ROOT/web/.cache"
export RUSTUP_HOME="${RUSTUP_HOME:-$CACHE/rustup}"
export CARGO_HOME="${CARGO_HOME:-$CACHE/cargo}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$CACHE/target}"
export PATH="$CARGO_HOME/bin:$PATH"

# 1. Rubber Band is a git submodule; some CI checkouts do not fetch submodules.
if [ ! -f vendor/rubberband/single/RubberBandSingle.cpp ]; then
    git submodule update --init --depth 1 vendor/rubberband
fi

# 2. Rust: rustup, the channel from rust-toolchain.toml, and the wasm32-wasip1 target.
if ! command -v rustup >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none --no-modify-path
fi
CHANNEL="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)"
if [ ! -d "$(rustup run "$CHANNEL" rustc --print sysroot 2>/dev/null)/lib/rustlib/wasm32-wasip1" ]; then
    rustup toolchain install "$CHANNEL" --profile minimal --target wasm32-wasip1 --no-self-update
fi

# 3. wasi-sdk for the C++ (Rubber Band). .cargo/config.toml names the macOS/arm64 copy; the [env]
#    entries there do not override variables that are already set, so point them at this platform's.
sh scripts/fetch-tools.sh
SDK="$(ls -d "$ROOT"/.tools/wasi-sdk-*/ | head -n 1)"
SDK="${SDK%/}"
export WASI_SDK_PATH="$SDK"
export CC_wasm32_wasip1="$SDK/bin/clang" CXX_wasm32_wasip1="$SDK/bin/clang++" AR_wasm32_wasip1="$SDK/bin/llvm-ar"

# 4. Trim the workspace (no ../Virtuus on this image) and build.
sh scripts/web-only-workspace.sh
cargo build -p apricity-web --release --target wasm32-wasip1
mkdir -p "$CACHE"
cp "$CARGO_TARGET_DIR/wasm32-wasip1/release/apricity_web.wasm" "$CACHE/apricity_web.wasm"
echo "wasm ready: $CACHE/apricity_web.wasm"
