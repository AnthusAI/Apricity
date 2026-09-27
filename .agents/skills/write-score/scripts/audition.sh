#!/bin/bash
# Audition a score: validate it, render it, and print what an agent needs to judge the result.
#
#     audition.sh examples/my-song.apr                  # render to renders/my-song.wav (+ .m4a)
#     audition.sh examples/my-song.apr --bars 9-16
#     audition.sh examples/my-song.apr --out DIR        # write the render (and stems) into DIR instead
#     audition.sh examples/my-song.apr --check          # also run the harmony checker (about 20 s)
#
# Prints: compile errors (with line and column), explain's warnings and each pitched track's pitch,
# the mix report (loudness and peak per track: a "silent" or very quiet track is the first thing
# to look at), with --check the harmony checker's objective and findings, and the paths to
# listen to / send (the small .m4a).
set -euo pipefail

score="${1:?usage: audition.sh <score.apr> [--bars a-b] [--out DIR] [--check]}"; shift
bars=""; check=""; outdir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bars) bars="$2"; shift 2 ;;
    --out) outdir="$2"; shift 2 ;;
    --check) check=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

repo="$(git -C "$(dirname "$score")" rev-parse --show-toplevel)"
main="$(dirname "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)")"
py="$main/analysis/.venv/bin/python"

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
dir="${outdir:-$repo/renders}"
mkdir -p "$dir"
out="$dir/$name${bars:+-bars-$bars}.wav"

echo "== compile"
"$bin" compile "$score" > /dev/null
echo "ok"

echo "== explain (warnings and pitched tracks)"
"$bin" explain "$score" | grep -E -i "warn|one sound at|guess" || echo "(nothing to flag)"

echo "== render"
args=(render "$score" -o "$out")
[ -n "$bars" ] && args+=(--bars "$bars")
# The harmony checker needs per-track stems; older builds without --stems fall back below.
stems="${out%.wav}.stems"
if [ -n "$check" ] && "$bin" render --help | grep -q -- '--stems'; then
  rm -rf "$stems"; args+=(--stems "$stems")
fi
"$bin" "${args[@]}"

if [ -n "$check" ]; then
  if [ -d "$stems" ] && [ -f "$repo/scripts/check-stems.py" ]; then
    echo "== harmony check (objective 0-100, higher is better; read the top findings, not only the number)"
    "$py" "$repo/scripts/check-stems.py" "$stems" --baseline "$dir/$name.baseline.json" 2>&1 | grep -v -i warn | head -30
  else
    echo "== round-trip check (the harmony checker isn't in this checkout; using the older mix-level check)"
    (cd "$repo" && "$py" "$main/scripts/check-render.py" "$score" "$out") 2>&1 | grep -v -i warn
  fi
fi

# A small copy to send (AAC); the WAV stays for analysis.
m4a="${out%.wav}.m4a"
afconvert -f m4af -d aac -b 192000 "$out" "$m4a" 2>/dev/null && echo "send: $m4a"

echo "== listen"
echo "afplay \"$out\""
