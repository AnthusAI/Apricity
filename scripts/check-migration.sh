#!/bin/bash
# Check migration: every score in examples/ must render sample-for-sample the same from the
# repository files and from a library migrated out of them (design/storage.md §5, step 6).
#
# Usage: scripts/check-migration.sh [--repo REPO_ROOT] [--lib LIB_PATH]
# Defaults: repo=., lib=a fresh temporary directory (removed on exit).
# APRICITY overrides the binary (default: target/release/apricity, else target/debug/apricity).

set -u

REPO_ROOT="."
LIB_PATH=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --repo) REPO_ROOT="$2"; shift 2 ;;
        --lib) LIB_PATH="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"
if [ -z "${APRICITY:-}" ]; then
    for candidate in "$REPO_ROOT/target/release/apricity" "$REPO_ROOT/target/debug/apricity"; do
        [ -x "$candidate" ] && APRICITY="$candidate" && break
    done
fi
if [ -z "${APRICITY:-}" ] || [ ! -x "$APRICITY" ]; then
    echo "apricity binary not found; run cargo build -p apricity-cli (or set APRICITY)" >&2
    exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
[ -z "$LIB_PATH" ] && LIB_PATH="$WORK/library"
rm -rf "$LIB_PATH"

echo "Check migration: repo=$REPO_ROOT lib=$LIB_PATH binary=$APRICITY"
if ! "$APRICITY" migrate --from "$REPO_ROOT" --to "$LIB_PATH" --link; then
    echo "FAILED: migration reported errors" >&2
    exit 1
fi

cd "$REPO_ROOT" || exit 2
passed=0
failed=0
for score in examples/*.apr examples/*.yaml; do
    [ -f "$score" ] || continue
    name="$(basename "$score")"
    files_wav="$WORK/$name.files.wav"
    lib_wav="$WORK/$name.lib.wav"
    if ! "$APRICITY" render "$score" --out "$files_wav" >"$WORK/$name.files.log" 2>&1; then
        echo "FAILED  $name: render from files failed"; tail -5 "$WORK/$name.files.log"
        failed=$((failed + 1)); continue
    fi
    if ! "$APRICITY" render "$score" --library "$LIB_PATH" --out "$lib_wav" >"$WORK/$name.lib.log" 2>&1; then
        echo "FAILED  $name: render from library failed"; tail -5 "$WORK/$name.lib.log"
        failed=$((failed + 1)); continue
    fi
    if cmp -s "$files_wav" "$lib_wav"; then
        echo "identical  $name"
        passed=$((passed + 1))
    else
        echo "FAILED  $name: WAVs differ"
        failed=$((failed + 1))
    fi
done

echo ""
echo "Check migration: $passed identical, $failed failed"
[ "$failed" -eq 0 ] && [ "$passed" -gt 0 ]
