#!/bin/bash
# Audition a score: validate it, render it, and print what an agent needs to judge the result.
#
#     audition.sh examples/my-song.apr            # render to renders/my-song.wav
#     audition.sh examples/my-song.apr --bars 9-16
#     audition.sh examples/my-song.apr --check    # also run the render round-trip check (slow)
#
# Prints: compile errors (with line and column), explain's warnings and each pitched track's pitch,
# the mix report (loudness and peak per track: a "silent" or very quiet track is the first thing
# to look at), and the WAV path to listen to (`afplay <wav>`).
set -euo pipefail

score="${1:?usage: audition.sh <score.apr> [--bars a-b] [--check]}"; shift
bars=""; check=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bars) bars="$2"; shift 2 ;;
    --check) check=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

repo="$(git -C "$(dirname "$score")" rev-parse --show-toplevel)"
main="$(dirname "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)")"

# The CLI: this checkout's release build if there is one, else the main checkout's.
bin="$repo/target/release/apricity"
[ -x "$bin" ] || bin="$main/target/release/apricity"
[ -x "$bin" ] || { echo "no apricity build; run: cargo build --release -p apricity-cli" >&2; exit 1; }

# Audio isn't in git. In a worktree, link the main checkout's sample audio in (still ignored by git)
# so compile, explain and render all see the same files.
if [ "$repo" != "$main" ] && [ -d "$main/samples" ]; then
  (cd "$main/samples" && find . -type f \( -name '*.wav' -o -name '*.mp3' -o -name '*.flac' \)) | while read -r f; do
    t="$repo/samples/${f#./}"
    [ -e "$t" ] || { mkdir -p "$(dirname "$t")"; ln -s "$main/samples/${f#./}" "$t"; }
  done
fi

name="$(basename "${score%.*}")"
out="$repo/renders/$name${bars:+-bars-$bars}.wav"
mkdir -p "$repo/renders"

echo "== compile"
if ! "$bin" compile "$score" > /dev/null; then exit 1; fi
echo "ok"

echo "== explain (warnings and pitched tracks)"
"$bin" explain "$score" | grep -E -i "warn|one sound at|guess" || echo "(nothing to flag)"

echo "== render"
if [ -n "$bars" ]; then "$bin" render "$score" -o "$out" --bars "$bars"; else "$bin" render "$score" -o "$out"; fi

if [ -n "$check" ]; then
  echo "== round-trip check"
  py="$main/analysis/.venv/bin/python"
  (cd "$repo" && "$py" "$main/scripts/check-render.py" "$score" "$out") 2>&1 | grep -v -i warn || true
fi

# A small copy to send (AAC); the WAV stays for analysis.
m4a="${out%.wav}.m4a"
afconvert -f m4af -d aac -b 192000 "$out" "$m4a" 2>/dev/null && echo "send: $m4a"

echo "== listen"
echo "afplay \"$out\""
