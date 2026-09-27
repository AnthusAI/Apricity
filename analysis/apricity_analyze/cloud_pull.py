"""Bring what people do on the hosted site back into the library.

Ratings, comments and handles live only in the cloud (DynamoDB behind AppSync; `CLOUD_ONLY` in
`web/src/data/import-library.ts`), so the library and everything that reads it (`apricity serve`,
the analysis) never saw them. `pull` mirrors them into the library's record folders, one file per
record, in the shape the local server already reads and writes:

    ~/Apricity-Library/Rating/<type>#<target>#<who>.json
    ~/Apricity-Library/Comment/<id>.json
    ~/Apricity-Library/Handle/<handle>.json

A cloud record carries an `owner` (the Cognito identity); records made locally have none, or a
`local` one, and are never touched. Only files whose content changed are rewritten, so library sync
doesn't churn, and a library copy of a cloud record that's gone from the cloud is removed. Local
tallies are summed from the Rating files (`web/src/data/ratings.ts`), so local mode then shows
everyone's ratings, not just this machine's.
"""

from __future__ import annotations

import dataclasses
import json
import pathlib
import subprocess
from decimal import Decimal
from typing import Callable, Iterable

MODELS = ("Rating", "Comment", "Handle")
#: the production tables' suffix (Amplify app d2n7w4kwqyfwn4, branch main)
TABLE_SUFFIX = "-nd3uprkpafehvjszmnn44mr7fi-NONE"


def plain(v: dict):
    """One DynamoDB attribute value ({"S": "x"}, {"N": "3"}, {"M": {...}}...) as plain JSON."""
    (t, x), = v.items()
    if t == "S":
        return x
    if t == "N":
        d = Decimal(x)
        return int(d) if d == d.to_integral_value() else float(d)
    if t == "BOOL":
        return x
    if t == "NULL":
        return None
    if t == "L":
        return [plain(e) for e in x]
    if t == "M":
        return {k: plain(e) for k, e in x.items()}
    if t in ("SS", "NS"):
        return [plain({t[0]: e}) for e in x]
    raise ValueError(f"unsupported DynamoDB type {t}")


def item(raw: dict) -> dict:
    return {k: plain(v) for k, v in raw.items()}


def text(record: dict) -> str:
    """A record file's text, as the library writes it (compact, keys sorted)."""
    return json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def from_cloud(record: dict) -> bool:
    owner = record.get("owner")
    return isinstance(owner, str) and owner != "local" and not owner.startswith("local::")


@dataclasses.dataclass
class Plan:
    write: dict[str, str] = dataclasses.field(default_factory=dict)  # filename -> text
    remove: list[str] = dataclasses.field(default_factory=list)
    same: int = 0


def plan(cloud: Iterable[dict], folder: pathlib.Path) -> Plan:
    """What to write and remove in one model's folder so it holds exactly the cloud's records (and its own)."""
    p = Plan()
    wanted = {}
    for r in cloud:
        wanted[f"{r['id']}.json"] = text(r)
    for name, body in wanted.items():
        f = folder / name
        if f.exists() and f.read_text() == body:
            p.same += 1
        else:
            p.write[name] = body
    if folder.exists():
        for f in sorted(folder.glob("*.json")):
            if f.name in wanted:
                continue
            try:
                had = json.loads(f.read_text())
            except ValueError:
                continue
            if from_cloud(had):
                p.remove.append(f.name)
    return p


def apply(p: Plan, folder: pathlib.Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for name, body in p.write.items():
        (folder / name).write_text(body)
    for name in p.remove:
        (folder / name).unlink()


def scan_with_aws_cli(table: str) -> list[dict]:
    """Every item in a table, through the `aws` CLI (its own credentials; run `aws login` first)."""
    out, token = [], None
    while True:
        cmd = ["aws", "dynamodb", "scan", "--table-name", table, "--output", "json"]
        if token:
            cmd += ["--starting-token", token]
        page = json.loads(subprocess.run(cmd, check=True, capture_output=True, text=True).stdout)
        out += [item(i) for i in page.get("Items", [])]
        token = page.get("NextToken")
        if not token:
            return out


def pull(library: pathlib.Path, *, scan: Callable[[str], list[dict]] = scan_with_aws_cli, suffix: str = TABLE_SUFFIX,
         dry_run: bool = False) -> dict[str, Plan]:
    """Mirror the cloud's Rating, Comment and Handle records into the library. Returns each model's plan."""
    plans = {}
    for model in MODELS:
        folder = library / model
        plans[model] = p = plan(scan(model + suffix), folder)
        if not dry_run:
            apply(p, folder)
    return plans
