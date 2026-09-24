#!/usr/bin/env python3
"""Move scores and manifests to Apricity's Live-aligned vocabulary (design/vocabulary.md).

    python3 scripts/migrate-vocabulary.py examples/*.apr examples/*.yaml    # scores, in place
    python3 scripts/migrate-vocabulary.py --manifests samples               # every *.apricity.json
    python3 scripts/migrate-vocabulary.py --check examples/*.apr            # report, change nothing

Scores (.apr):
- `meter 4` becomes `time 4/4`;
- `slice NAME` on a clip or pad moves right after the path as the saved clip's name, and `hit-N`
  becomes `shot-N`;
- `chop` becomes `slice`, `by hits` becomes `by transients`, and `warp off` becomes `warp repitch`;
- `bus` becomes `group` (if tracks go `out` to it) or `return` (if they only send to it);
- `gain` becomes `volume`, and `out` becomes `group`.

YAML scores get the same changes.

Manifests:
- `annotations.slices` becomes `annotations.clips`;
- `hit` markers become `transient`;
- `hit-N` clips become `shot-N`;
- version 1 becomes version 2.
"""

import json
import re
import sys
from pathlib import Path


def saved(name: str) -> str:
    return re.sub(r"^hit-(\d+)$", r"shot-\1", name)


def split_comment(line: str) -> tuple[str, str]:
    """Code and `# comment`, ignoring `#` inside quotes."""
    quoted = False
    for i, c in enumerate(line):
        if c == '"':
            quoted = not quoted
        elif c == "#" and not quoted:
            return line[:i], line[i:]
    return line, ""


def move_saved(code: str, head: re.Pattern) -> str:
    """`… = PATH opts slice NAME opts` → `… = PATH NAME opts opts`."""
    m = re.search(r"(\s+)slice\s+([\w.-]+)", code)
    if not m:
        return code
    code = code[: m.start()] + code[m.end():]
    h = head.match(code)
    return code[: h.end()] + "  " + saved(m.group(2)) + code[h.end():] if h else code


def migrate_apr(text: str, notes: list[str]) -> str:
    groups = set(re.findall(r"\bout\s+([\w-]+)", text)) - {"master"}
    out = []
    for line in text.split("\n"):
        code, comment = split_comment(line)
        words = code.split()
        indented = code[:1] in (" ", "\t")
        head = words[0] if words else ""
        if not indented and head == "meter":
            code = re.sub(r"\bmeter\s+(\d+)", r"time \1/4", code)
        elif not indented and head == "clip":
            code = move_saved(code, re.compile(r"\s*clip\s+[\w-]+\s*=\s*\S+"))
            code = re.sub(r"\bwarp\s+off\b", "warp repitch", code)
        elif indented and len(words) > 2 and words[1] == "=":
            code = move_saved(code, re.compile(r"\s*[\w-]+\s*=\s*\S+"))
        elif not indented and head == "kit":
            code = re.sub(r"=\s*chop\b", "= slice", code)
            code = re.sub(r"\bby\s+hits\b", "by transients", code)
        elif not indented and head == "track":
            code = re.sub(r"(\s)gain(\s)", r"\1volume\2", code)
            code = re.sub(r"(\s)out(\s)", r"\1group\2", code)
        elif not indented and head == "bus":
            name = words[1] if len(words) > 1 else ""
            kind = "group" if name in groups else "return"
            code = re.sub(r"\bbus\b", kind, code, count=1)
            code = re.sub(r"(\s)gain(\s)", r"\1volume\2", code)
            if kind == "group":
                code = re.sub(r"(\s)out(\s)", r"\1group\2", code)
            elif re.search(r"\sout\s+[\w-]+", code):
                notes.append(f"return {name}: dropped `out` (return tracks play into the master)")
                code = re.sub(r"\s+out\s+[\w-]+", "", code)
        out.append(code + comment)
    return "\n".join(out)


def migrate_yaml(text: str, notes: list[str]) -> str:
    text = re.sub(r"^meter:\s*(\d+)", r"time: \1/4", text, flags=re.M)
    text = re.sub(r"\bslice:\s*([\w.-]+)", lambda m: f"saved: {saved(m.group(1))}", text)
    text = re.sub(r"\bchop:\s*hits\b", "slice: transients", text)
    text = re.sub(r"\bchop:", "slice:", text)
    text = re.sub(r"\bwarp:\s*off\b", "warp: repitch", text)
    text = re.sub(r"\bgain:", "volume:", text)
    text = re.sub(r"\bout:", "group:", text)
    if re.search(r"^buses:", text, flags=re.M):
        notes.append("has `buses:`: split it into `groups:` and `returns:` by hand")
    return text


def migrate_manifest(path: Path) -> bool:
    m = json.loads(path.read_text())
    ann = m.get("annotations", {})
    if m.get("apricity_manifest", 1) >= 2 and "slices" not in ann:
        return False
    clips = ann.pop("slices", None) or ann.get("clips", [])
    for c in clips:
        c["name"] = saved(c["name"])
    ann["clips"] = clips
    for k in ann.get("markers", []):
        if k.get("name") == "hit":
            k["name"] = "transient"
    m["annotations"] = ann
    m["apricity_manifest"] = 2
    path.write_text(json.dumps(m, indent=1) + "\n")
    return True


def main(argv: list[str]) -> int:
    check = "--check" in argv
    argv = [a for a in argv if a != "--check"]
    if argv[:1] == ["--manifests"]:
        roots = [Path(a) for a in argv[1:]] or [Path("samples")]
        n = sum(migrate_manifest(p) for r in roots for p in sorted(r.rglob("*.apricity.json")) if not check)
        print(f"{n} manifests migrated")
        return 0
    changed = 0
    for a in argv:
        p = Path(a)
        notes: list[str] = []
        old = p.read_text()
        new = migrate_yaml(old, notes) if p.suffix in (".yaml", ".yml") else migrate_apr(old, notes)
        for n in notes:
            print(f"{p}: {n}")
        if new != old:
            changed += 1
            print(f"{p}: {'would change' if check else 'migrated'}")
            if not check:
                p.write_text(new)
    print(f"{changed} of {len(argv)} scores {'need changes' if check else 'migrated'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
