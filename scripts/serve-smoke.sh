#!/bin/bash
# Smoke-test `apricity serve` on a migrated library (design/storage.md section 4).
# Usage: scripts/serve-smoke.sh [--repo REPO_ROOT]
# APRICITY overrides the binary (default: the newer of target/release and target/debug).

set -u
REPO_ROOT="."
while [[ $# -gt 0 ]]; do
    case $1 in
        --repo) REPO_ROOT="$2"; shift 2 ;;
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

WORK="$(mktemp -d)"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null && wait "$PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
LIB="$WORK/library"
failed=0
check() { if [ "$2" = "0" ]; then echo "ok      $1"; else echo "FAILED  $1"; failed=$((failed + 1)); fi; }

"$APRICITY" migrate --from "$REPO_ROOT" --to "$LIB" --link >"$WORK/migrate.log" 2>&1 || { echo "migrate failed"; tail -5 "$WORK/migrate.log"; exit 1; }

WEB_ARGS=()
[ -d "$REPO_ROOT/web/dist" ] && WEB_ARGS=(--web "$REPO_ROOT/web/dist")
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
echo "serving $LIB at $BASE"

OUT="$(curl -s "$BASE/amplify_outputs.json")"
KEY="$(printf '%s' "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["api_key"])')"
printf '%s' "$OUT" | python3 -c '
import json, sys
o = json.load(sys.stdin); d = o["data"]
assert d["url"].endswith("/graphql") and d["aws_region"] == "local"
assert d["default_authorization_type"] == "API_KEY" and d["api_key"]
assert "Clip" in d["model_introspection"]["models"]
assert o["custom"]["apricity"]["mode"] == "local" and o["custom"]["apricity"]["identity"]["sub"]
assert "auth" not in o and "storage" not in o
'
check "amplify_outputs.json fields" $?

QUERY='{"query":"{ listClips(limit: 1000) { items { id title audio { key size } } } }"}'
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d "$QUERY" "$BASE/graphql")"
[ "$CODE" = "401" ]; check "graphql without API key is 401 (got $CODE)" $?
curl -s -X POST -H 'content-type: application/json' -H "x-api-key: $KEY" -d "$QUERY" "$BASE/graphql" >"$WORK/clips.json"
python3 -c '
import json, sys
items = json.load(open(sys.argv[1]))["data"]["listClips"]["items"]
assert len(items) > 0 and all(i["id"] and i["audio"]["key"] for i in items)
print("        listClips returned", len(items), "clips")
' "$WORK/clips.json"
check "listClips returns real data" $?

# Pick the largest audio file and compare a mid-file byte range with the original.
KEYPATH="$(python3 -c '
import json, os, sys
lib = sys.argv[2]
items = json.load(open(sys.argv[1]))["data"]["listClips"]["items"]
items = [i for i in items if os.path.exists(os.path.join(lib, "files", i["audio"]["key"]))]
print(max(items, key=lambda i: os.path.getsize(os.path.join(lib, "files", i["audio"]["key"])))["audio"]["key"])
' "$WORK/clips.json" "$LIB")"
ORIG="$LIB/files/$KEYPATH"
SIZE="$(wc -c <"$ORIG" | tr -d ' ')"
START=$((SIZE / 3)); END=$((START + 65535)); [ "$END" -ge "$SIZE" ] && END=$((SIZE - 1))
LEN=$((END - START + 1))
CODE="$(curl -s -D "$WORK/h.txt" -o "$WORK/range.bin" -w '%{http_code}' -H "Range: bytes=$START-$END" "$BASE/files/$KEYPATH")"
[ "$CODE" = "206" ]; check "range request is 206 (got $CODE) for $KEYPATH" $?
grep -qi "^content-range: bytes $START-$END/$SIZE" "$WORK/h.txt"; check "Content-Range bytes $START-$END/$SIZE" $?
tail -c +$((START + 1)) "$ORIG" | head -c "$LEN" >"$WORK/expected.bin"
cmp -s "$WORK/range.bin" "$WORK/expected.bin"; check "range bytes identical to the original ($LEN bytes)" $?
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Range: bytes=$SIZE-" "$BASE/files/$KEYPATH")"
[ "$CODE" = "416" ]; check "range past the end is 416 (got $CODE)" $?
curl -s -o "$WORK/whole.bin" "$BASE/files/$KEYPATH"
cmp -s "$WORK/whole.bin" "$ORIG"; check "whole file identical to the original" $?
CODE="$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$BASE/files/../apricity-library.json")"
[ "$CODE" = "400" ] || [ "$CODE" = "404" ]; check "key traversal rejected (got $CODE)" $?

if [ -d "$REPO_ROOT/web/dist" ]; then
    CODE="$(curl -s -D "$WORK/root.txt" -o /dev/null -w '%{http_code}' "$BASE/")"
    [ "$CODE" = "200" ]; check "GET / is 200 (got $CODE)" $?
    grep -qi "^cross-origin-opener-policy: same-origin" "$WORK/root.txt"; check "COOP header on /" $?
    grep -qi "^cross-origin-embedder-policy: require-corp" "$WORK/root.txt"; check "COEP header on /" $?
    grep -qi "^cross-origin-resource-policy: same-origin" "$WORK/root.txt"; check "CORP header on /" $?
else
    echo "SKIPPED web/dist is not built; / would be a 404 (run npm run build in web/)"
fi

echo ""
if [ "$failed" -eq 0 ]; then echo "serve smoke: all checks passed"; else echo "serve smoke: $failed failed"; fi
[ "$failed" -eq 0 ]
