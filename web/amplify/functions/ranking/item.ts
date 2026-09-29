// What the ranking Lambda knows about an item, from its records (as DynamoDB returns them), and its rows back as
// DynamoDB items. Pure (test/ranking-lambda.test.ts).

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { RankedRow, RankItem, TargetType } from "../../../src/data/ranked";
import type { HomeKind } from "../../../src/data/home-feed";
import type { DayTally } from "../../../src/data/rank-window";
import { documented, type Provenance } from "../../../src/data/licenses";

type Image = Record<string, AttributeValue> | undefined;

const str = (i: Image, k: string) => (i?.[k] && "S" in i[k] ? (i[k] as { S: string }).S : undefined);
const num = (i: Image, k: string) => (i?.[k] && "N" in i[k] ? Number((i[k] as { N: string }).N) : undefined);
const list = (i: Image, k: string) => (i?.[k] && "L" in i[k] ? ((i[k] as { L: AttributeValue[] }).L.map((v) => ("S" in v ? v.S : undefined)).filter(Boolean) as string[]) : []);

const KINDS: HomeKind[] = ["song", "beat", "chords", "melody", "sample", "clip"];

/** The records an item's rows are made from: its Activity card and its own record (and a clip's sample). */
export interface ItemRecords {
  card: Image;
  score?: Image;
  sample?: Image;
  clip?: Image;
}

/** An item as its rows need it, or null when it has no card (it isn't in the feed). */
export function itemOf(targetType: TargetType, targetId: string, r: ItemRecords): RankItem | null {
  const card = r.card;
  const lastAt = str(card, "lastAt");
  if (!card || !lastAt) return null;
  const k = str(card, "kind") ?? (targetType === "score" ? "song" : targetType);
  const kind = (KINDS.includes(k as HomeKind) ? k : targetType === "score" ? "song" : targetType) as HomeKind;
  const base = {
    targetType,
    targetId,
    kind,
    title: str(card, "title") ?? "",
    owner: str(card, "owner") ?? null,
    tags: [] as string[],
    lastAt,
    lastWhat: str(card, "lastWhat") ?? null,
    lastBy: str(card, "lastBy") ?? null,
    comments: num(card, "comments") ?? 0,
  };
  if (targetType === "score") {
    const s = r.score;
    if (!s) return null;
    const path = `${str(s, "folder")}/${str(s, "title")}.${str(s, "format") ?? "apr"}`;
    return { ...base, title: str(s, "title") ?? base.title, path, tags: list(s, "tags") };
  }
  if (targetType === "sample") {
    const p = str(r.sample, "path");
    return p ? { ...base, path: `samples/${p}` } : null;
  }
  const p = str(r.sample, "path");
  const retired = r.clip?.retired && "BOOL" in r.clip.retired ? r.clip.retired.BOOL : false;
  if (!p || !r.clip || retired) return null;
  return { ...base, title: str(r.clip, "name") ?? base.title, path: `samples/${p}`, samplePath: `samples/${p}`, clipStart: num(r.clip, "start") ?? null, clipEnd: num(r.clip, "end") ?? null };
}

/** Tally rows as the ranking reads them. */
export function talliesOf(items: Record<string, AttributeValue>[]): DayTally[] {
  return items.map((t) => ({ targetId: str(t, "targetId") ?? "", day: str(t, "day") ?? "", count: num(t, "count") ?? 0, sum: num(t, "sum") ?? 0 }));
}

/** A row as a DynamoDB item of the Ranked table (with the model's bookkeeping fields). */
export function rowItem(r: RankedRow, now: string): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {
    id: { S: r.id },
    __typename: { S: "Ranked" },
    list: { S: r.list },
    sort: { S: r.sort },
    targetType: { S: r.targetType },
    targetId: { S: r.targetId },
    kind: { S: r.kind },
    lastAt: { S: r.lastAt },
    ratings: { N: String(r.ratings) },
    createdAt: { S: now },
    updatedAt: { S: now },
  };
  const s = (k: string, v: string | null | undefined) => v && (out[k] = { S: v });
  const n = (k: string, v: number | null | undefined) => v !== null && v !== undefined && Number.isFinite(v) && (out[k] = { N: String(v) });
  s("title", r.title);
  s("owner", r.owner);
  s("path", r.path);
  s("samplePath", r.samplePath);
  s("lastWhat", r.lastWhat);
  s("lastBy", r.lastBy);
  n("clipStart", r.clipStart);
  n("clipEnd", r.clipEnd);
  n("stars", r.stars);
  n("comments", r.comments);
  if (r.tags.length) out.tags = { L: r.tags.map((t) => ({ S: t })) };
  return out;
}

/** Whether a Recording record says enough to use its sound (licenses.ts `documented`); no record: no. */
export function documentedRecording(image: Image): boolean {
  if (!image) return false;
  const p: Provenance = {};
  for (const k of ["license", "rights", "credit", "author", "attribution"] as const) p[k] = str(image, k) ?? null;
  return documented(p);
}

/** A string field of a record (for the handler's lookups). */
export const field = str;

/**
 * Which stored fields changing can change what's hidden: a sample's recording, or whether a recording is documented.
 * An insert or removal always can.
 */
export function hidingChanged(table: "Sample" | "Recording", oldImage: Image, newImage: Image): boolean {
  if (!oldImage || !newImage) return true;
  if (table === "Sample") return str(oldImage, "recordingId") !== str(newImage, "recordingId");
  return documentedRecording(oldImage) !== documentedRecording(newImage);
}

/** Which item a stream record is about: [type, id], from any of the tables the Lambda listens to. */
export function targetOf(table: "Activity" | "Tally" | "Score", image: Image): [TargetType, string] | null {
  if (table === "Score") {
    const id = str(image, "id");
    return id ? ["score", id] : null;
  }
  const type = str(image, "targetType") as TargetType | undefined;
  const id = str(image, "targetId");
  return type && id ? [type, id] : null;
}
