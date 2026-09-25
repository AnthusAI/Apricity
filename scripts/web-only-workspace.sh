#!/bin/sh
# Trim this checkout to the crates the browser wasm module needs, for CI images that have only this
# repository (AWS Amplify Hosting). The CLI and apricity-data's `storage` feature depend by path on
# the sibling Virtuus repository (../Virtuus), and Cargo reads every path manifest in the workspace
# and in the dependency graph even when nothing builds it, so on such an image they must be removed
# from the manifests. This edits the working tree in place and is meant for throwaway CI checkouts.
# Do not run it in a development clone. Usage: scripts/web-only-workspace.sh [REPO_ROOT]
set -eu
cd "${1:-$(dirname "$0")/..}"

edit() { # edit FILE SED-EXPRESSION...
    file=$1; shift
    sed "$@" "$file" > "$file.tmp" && mv "$file.tmp" "$file"
}

edit Cargo.toml -e 's|^members = .*|members = ["crates/apricity-data", "crates/apricity-dsp", "crates/apricity-engine", "crates/apricity-score", "crates/apricity-theory", "crates/apricity-web"]|'
edit crates/apricity-data/Cargo.toml -e '/^virtuus-amplify = /d' -e 's|"dep:virtuus-amplify", ||'

if grep -rn "virtuus" Cargo.toml crates/apricity-data/Cargo.toml crates/apricity-dsp/Cargo.toml \
    crates/apricity-engine/Cargo.toml crates/apricity-score/Cargo.toml crates/apricity-theory/Cargo.toml \
    crates/apricity-web/Cargo.toml; then
    echo "web-only-workspace: a Virtuus reference is still in the manifests" >&2
    exit 1
fi
echo "web-only workspace: cli and the Virtuus path dependency removed"
