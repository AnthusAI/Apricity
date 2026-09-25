#!/bin/bash
# Smoke-test the landing hero's sound path end to end: migrate (or reuse) a library, write the hero
# audio into it with scripts/hero-data.py, serve it with `apricity serve --library` plus the built web
# app, and check every hero audio key is served as audio, the way the browser asks for it.
# Usage: scripts/hero-smoke.sh [--repo REPO_ROOT] [--library DIR]
#   --library DIR  reuse a migrated library (the hero audio is written into it; nothing else changes)
#                  instead of migrating a throwaway one.
# APRICITY overrides the binary (default: the newer of target/release and target/debug).
# PYTHON overrides the interpreter (default: analysis/.venv/bin/python).
# Needs: web/dist built (cd web && npm run build), ffmpeg, samples downloaded for the migrate.

set -u
REPO_ROOT="."
LIB=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --repo) REPO_ROOT="$2"; shift 2 ;;
        --library) LIB="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"
if [ -z "${APRICITY:-}" ]; then
    for c in "$REPO_ROOT/target/release/apricity" "$REPO_ROOT/target/debug/apricity"; do
        [ -x "$c" ] || continue
        if [ -z "${APRICITY:-}" ] || [ "$c" -nt "$APRICITY" ]; then APRICITY="$c"; fi
    done
fi
[ -n "${APRICITY:-}" ] && [ -x "$APRICITY" ] || { echo "apricity binary not found; cargo build -p apricity-cli" >&2; exit 2; }
export APRICITY
PYTHON="${PYTHON:-$REPO_ROOT/analysis/.venv/bin/python}"
[ -x "$PYTHON" ] || { echo "python not found at $PYTHON" >&2; exit 2; }
[ -d "$REPO_ROOT/web/dist" ] || { echo "web/dist is not built; run npm run build in web/" >&2; exit 2; }

WORK="$(mktemp -d)"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null && wait "$PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
failed=0
check() { if [ "$2" = "0" ]; then echo "ok      $1"; else echo "FAILED  $1"; failed=$((failed + 1)); fi; }

if [ -z "$LIB" ]; then
    LIB="$WORK/library"
    "$APRICITY" migrate --from "$REPO_ROOT" --to "$LIB" --link >"$WORK/migrate.log" 2>&1 || { echo "migrate failed"; tail -5 "$WORK/migrate.log"; exit 1; }
fi
[ -f "$LIB/apricity-library.json" ] || { echo "$LIB is not a library"; exit 1; }
echo "library $LIB"

# The keys the hero asks for, straight from the baked data.
KEYS="$("$PYTHON" -c '
import json, sys
a = json.load(open(sys.argv[1]))["audio"]
print("\n".join(dict.fromkeys(a["sources"] + [t["key"] for t in a["tracks"]])))
' "$REPO_ROOT/web/src/ui/flow/hero-data.json")"
[ "$(printf '%s\n' "$KEYS" | wc -l | tr -d ' ')" = "4" ]; check "hero-data.json names four audio keys" $?

# hero-data.json holds library keys only.
! grep -q '/Users/' "$REPO_ROOT/web/src/ui/flow/hero-data.json"; check "hero-data.json has no '/Users/'" $?

# Nothing in the app bundle carries the audio.
[ -z "$(find "$REPO_ROOT/web/dist" -name '*.mp3' -o -name '*.wav' -o -type d -name hero)" ]; check "web/dist bundles no audio and no hero folder" $?

# Bake the hero into the library (also rewrites hero-data.json; it must come out the same).
cp "$REPO_ROOT/web/src/ui/flow/hero-data.json" "$WORK/hero-data.before.json"
rm -rf "$LIB/files/hero"
"$PYTHON" "$REPO_ROOT/scripts/hero-data.py" --library "$LIB" >"$WORK/hero.log" 2>&1 || { echo "hero-data.py failed"; tail -8 "$WORK/hero.log"; exit 1; }
cmp -s "$WORK/hero-data.before.json" "$REPO_ROOT/web/src/ui/flow/hero-data.json"; check "regenerating hero-data.json from the library reproduces the committed file" $?
! grep -q '/Users/' "$REPO_ROOT/web/src/ui/flow/hero-data.json"; check "regenerated hero-data.json has no '/Users/'" $?

for k in $KEYS; do [ -s "$LIB/files/$k" ]; check "library holds files/$k" $?; done
# Ordinary library files: not dot-named, so `apricity sync` sees them.
[ -z "$(cd "$LIB/files" && find hero -name '.*')" ]; check "hero files are plain non-dot library files" $?
"$APRICITY" sync status --library "$LIB" --remote-dir "$WORK/remote" >"$WORK/status.txt" 2>&1
for k in $KEYS; do grep -q "files/$k" "$WORK/status.txt"; check "sync plans to push files/$k" $?; done

WEB_ARGS=(--web "$REPO_ROOT/web/dist")
"$APRICITY" serve --library "$LIB" --port 0 "${WEB_ARGS[@]}" >"$WORK/serve.log" 2>"$WORK/serve.err" &
PID=$!
BASE=""
for _ in $(seq 1 100); do
    BASE="$(sed -n 's/^listening on //p' "$WORK/serve.log")"
    [ -n "$BASE" ] && break
    kill -0 "$PID" 2>/dev/null || { echo "serve exited early"; cat "$WORK/serve.err"; exit 1; }
    sleep 0.1
done
[ -n "$BASE" ] || { echo "serve did not start"; exit 1; }
echo "serving at $BASE"

is_mp3() { # first bytes: an ID3 tag, or an MPEG frame sync
    local h; h="$(head -c 3 "$1" | od -An -tx1 | tr -d ' \n')"
    [ "$h" = "494433" ] || [[ "$h" == ff[ef]* ]] || [[ "$h" == fff* ]]
}
for k in $KEYS; do
    SIZE="$(wc -c <"$LIB/files/$k" | tr -d ' ')"
    # As files.ts asks in local mode: the whole key percent-encoded, slash included.
    ENC="$(printf '%s' "$k" | sed 's#/#%2F#g')"
    CODE="$(curl -s -o "$WORK/body.bin" -w '%{http_code}' "$BASE/files/$ENC")"
    { [ "$CODE" = "200" ] || [ "$CODE" = "206" ]; } && is_mp3 "$WORK/body.bin" && cmp -s "$WORK/body.bin" "$LIB/files/$k"
    check "GET /files/$ENC -> $CODE, $SIZE bytes of audio identical to the library file" $?
    CODE="$(curl -s -o "$WORK/plain.bin" -w '%{http_code}' "$BASE/files/$k")"
    { [ "$CODE" = "200" ] || [ "$CODE" = "206" ]; } && cmp -s "$WORK/plain.bin" "$LIB/files/$k"
    check "GET /files/$k -> $CODE" $?
    CODE="$(curl -s -o "$WORK/one.bin" -w '%{http_code}' -H 'Range: bytes=0-0' "$BASE/files/$ENC")"
    [ "$CODE" = "206" ] && [ "$(wc -c <"$WORK/one.bin" | tr -d ' ')" = "1" ]
    check "the sound probe (Range: bytes=0-0) -> $CODE, 1 byte" $?
done
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/files/hero%2Fnot-there.mp3")"
[ "$CODE" = "404" ]; check "a key the library lacks is 404 (the silent fallback; got $CODE)" $?
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
[ "$CODE" = "200" ]; check "the web app is served at / (got $CODE)" $?

kill "$PID" 2>/dev/null && wait "$PID" 2>/dev/null; PID=""
echo ""
if [ "$failed" -eq 0 ]; then echo "hero smoke: all checks passed"; else echo "hero smoke: $failed failed"; fi
[ "$failed" -eq 0 ]
