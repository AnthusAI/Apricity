#!/bin/bash
# Smoke-test `apricity sync` on a migrated library, with a folder as the remote
# (design/storage.md, "Sync and the bucket layout"). Needs no AWS.
# Usage: scripts/sync-smoke.sh [--repo REPO_ROOT]
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
trap 'rm -rf "$WORK"' EXIT
LIB="$WORK/library"; REMOTE="$WORK/remote"; LIB2="$WORK/library2"
failed=0
check() { if [ "$2" = "0" ]; then echo "ok      $1"; else echo "FAILED  $1"; failed=$((failed + 1)); fi; }
# Two trees hold the same syncable files with identical bytes (machine-local dot names and
# apricity-library.json aside; empty folders are not files). Details go to $WORK/diff.txt.
list_files() { (cd "$1" && find . -type f -not -path '*/.*' -not -name apricity-library.json | sort); }
same_tree() {
    list_files "$1" >"$WORK/list1"; list_files "$2" >"$WORK/list2"
    diff "$WORK/list1" "$WORK/list2" >"$WORK/diff.txt" 2>&1 || return 1
    while IFS= read -r f; do cmp -s "$1/$f" "$2/$f" || { echo "differs: $f" >>"$WORK/diff.txt"; return 1; }; done <"$WORK/list1"
}
# Number of syncable files under a tree.
count_files() { find "$1" -type f -not -path '*/.*' -not -name apricity-library.json | wc -l | tr -d ' '; }
# "N" from a line like "transferred: 12 pushed, ..." (word is pushed|pulled).
transferred() { sed -n "s/^transferred: .*[ :]\([0-9][0-9]*\) $2,.*/\1/p; s/^transferred: \([0-9][0-9]*\) $2,.*/\1/p" "$1" | head -1; }

"$APRICITY" migrate --from "$REPO_ROOT" --to "$LIB" --link >"$WORK/migrate.log" 2>&1 || { echo "migrate failed"; tail -5 "$WORK/migrate.log"; exit 1; }
# Keep the smoke test light: drop hard links to audio over 8 MB (the samples themselves are untouched).
find "$LIB/files" -type f -size +16384 -delete   # 512-byte blocks: 8 MB
find "$LIB/files" -type d -empty -delete
TOTAL="$(count_files "$LIB")"
echo "library $LIB: $TOTAL syncable files"
mkdir -p "$LIB/.virtuus"; echo lock >"$LIB/.virtuus/lock"; echo junk >"$LIB/.DS_Store"; echo half >"$LIB/files/.upload-1-2"

# status transfers and creates nothing
"$APRICITY" sync status --library "$LIB" --remote-dir "$REMOTE" >"$WORK/status.txt" 2>&1
check "status succeeds" $?
grep -q "^plan: $TOTAL to push, 0 to pull" "$WORK/status.txt"; check "status plans $TOTAL pushes" $?
[ ! -e "$REMOTE" ] && [ ! -e "$LIB/.apricity-sync.json" ]; check "status creates no remote and records no state" $?
"$APRICITY" sync push --library "$LIB" --remote-dir "$REMOTE" --dry-run >/dev/null 2>&1
[ ! -e "$REMOTE" ]; check "push --dry-run transfers nothing" $?

# first push: everything, byte for byte
"$APRICITY" sync push --library "$LIB" --remote-dir "$REMOTE" >"$WORK/push1.txt" 2>&1
check "first push succeeds" $?
[ "$(transferred "$WORK/push1.txt" pushed)" = "$TOTAL" ]; check "first push transferred all $TOTAL files (got $(transferred "$WORK/push1.txt" pushed))" $?
same_tree "$LIB" "$REMOTE"; check "remote tree identical to the library (same files, cmp)" $?
[ "$(count_files "$REMOTE")" = "$TOTAL" ]; check "remote holds exactly $TOTAL files" $?
[ -z "$(find "$REMOTE" -name '.*' -o -name apricity-library.json)" ]; check "no machine-local files reached the remote" $?
[ -f "$LIB/.apricity-sync.json" ]; check "last-sync state recorded in the library" $?

# a second push has nothing to do
"$APRICITY" sync push --library "$LIB" --remote-dir "$REMOTE" >"$WORK/push2.txt" 2>&1
[ "$(transferred "$WORK/push2.txt" pushed)" = "0" ]; check "second push transfers 0 files" $?

# modify one file, add another: only those two go
F="$(find "$LIB/Clip" -type f -name '*.json' | sort | head -1)"
[ -f "$F" ] || { echo "no Clip record found in $LIB"; exit 1; }
REL="${F#$LIB/}"
{ cat "$F"; echo; } >"$WORK/edited" && mv "$WORK/edited" "$F"
mkdir -p "$LIB/files/documents/smoke" && echo "new document" >"$LIB/files/documents/smoke/new.txt"
"$APRICITY" sync push --library "$LIB" --remote-dir "$REMOTE" >"$WORK/push3.txt" 2>&1
[ "$(transferred "$WORK/push3.txt" pushed)" = "2" ]; check "push after one edit and one addition transfers exactly 2 files (got $(transferred "$WORK/push3.txt" pushed))" $?
grep -q "push          $REL" "$WORK/push3.txt" && grep -q "push          files/documents/smoke/new.txt" "$WORK/push3.txt"; check "the two files are $REL and the new document" $?
same_tree "$LIB" "$REMOTE"; check "remote identical again" $?

# pull into a fresh second library (created by the pull)
"$APRICITY" sync pull --library "$LIB2" --remote-dir "$REMOTE" >"$WORK/pull1.txt" 2>&1
check "pull into a new library succeeds" $?
[ -f "$LIB2/apricity-library.json" ]; check "the pull created a library" $?
[ "$(transferred "$WORK/pull1.txt" pulled)" = "$((TOTAL + 1))" ]; check "pull transferred all $((TOTAL + 1)) files (got $(transferred "$WORK/pull1.txt" pulled))" $?
same_tree "$LIB" "$LIB2"; check "second library identical to the first (same files, cmp)" $?
BAD=0
while IFS= read -r f; do cmp -s "$LIB/${f#$LIB2/}" "$f" || BAD=$((BAD + 1)); done < <(find "$LIB2" -type f -not -path '*/.*' -not -name apricity-library.json)
[ "$BAD" = "0" ]; check "cmp: every pulled file byte-identical ($BAD differ)" $?
"$APRICITY" sync pull --library "$LIB2" --remote-dir "$REMOTE" >"$WORK/pull2.txt" 2>&1
[ "$(transferred "$WORK/pull2.txt" pulled)" = "0" ]; check "second pull transfers 0 files" $?

# deletions need --delete
DEL="files/documents/smoke/new.txt"
rm "$LIB/$DEL"
"$APRICITY" sync push --library "$LIB" --remote-dir "$REMOTE" >"$WORK/del1.txt" 2>&1
[ -f "$REMOTE/$DEL" ] && grep -q "pass --delete" "$WORK/del1.txt"; check "push without --delete keeps the remote file and says why" $?
"$APRICITY" sync push --library "$LIB" --remote-dir "$REMOTE" --delete >"$WORK/del2.txt" 2>&1
[ ! -e "$REMOTE/$DEL" ]; check "push --delete removes it from the remote" $?

# conflict: change the same file on both sides
cp "$F" "$WORK/local.expected"
printf 'local change\n' >>"$F"; cp "$F" "$WORK/local.expected"
printf 'remote change\n' >>"$REMOTE/$REL"; cp "$REMOTE/$REL" "$WORK/remote.expected"
"$APRICITY" sync push --library "$LIB" --remote-dir "$REMOTE" >"$WORK/conflict.txt" 2>"$WORK/conflict.err"
[ "$?" != "0" ]; check "conflicting push exits non-zero" $?
grep -q "CONFLICT      $REL" "$WORK/conflict.txt"; check "the conflict is reported by key" $?
cmp -s "$F" "$WORK/local.expected" && cmp -s "$REMOTE/$REL" "$WORK/remote.expected"; check "both copies left untouched" $?
"$APRICITY" sync pull --library "$LIB" --remote-dir "$REMOTE" >/dev/null 2>&1
[ "$?" != "0" ] && cmp -s "$F" "$WORK/local.expected"; check "conflicting pull also fails and keeps the local copy" $?
"$APRICITY" sync push --library "$LIB" --remote-dir "$REMOTE" --prefer local >"$WORK/prefer.txt" 2>&1
check "--prefer local resolves it" $?
cmp -s "$F" "$REMOTE/$REL"; check "the remote now has the local copy" $?

echo ""
if [ "$failed" -eq 0 ]; then echo "sync smoke: all checks passed"; else echo "sync smoke: $failed failed"; fi
[ "$failed" -eq 0 ]
