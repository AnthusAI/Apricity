// Keeps the Ranked table (design/scale.md §2.2): whenever an item's Activity card, its tallies or (a score's) record
// changes, its rows are rebuilt: every list it's in, in its current place, stale rows (a removed tag, a gone item)
// deleted. Once a day (EventBridge) every item in the feed, and every score, is rebuilt, so freshness and the week and
// month windows age.
//
// It also keeps two small lists the pages read instead of whole tables:
// - `hidden`: items only curators see, because they use a sample whose recording has no documented license. A
//   recording documented or not, a sample moved to another recording, or a score's samples changing, rebuilds
//   everything that could change with it.
// - `tags`: one row per tag, with how many scores use it, recounted when a score's tags change.
// Rebuilding is idempotent: a retry, or the nightly pass, never leaves a row twice.

import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent, ScheduledEvent } from "aws-lambda";
import {
  BatchWriteItemCommand,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  type AttributeValue,
  type WriteRequest,
} from "@aws-sdk/client-dynamodb";
import { hiddenRow, rowsFor, tagRow, tagsIn, TAGS, type RankedRow, type TargetType } from "../../../src/data/ranked";
import { documentedRecording, field, hidingChanged, itemOf, rowItem, talliesOf, targetOf, type ItemRecords } from "./item";

const db = new DynamoDBClient();
const T = {
  Activity: process.env.ACTIVITY_TABLE!,
  Score: process.env.SCORE_TABLE!,
  Sample: process.env.SAMPLE_TABLE!,
  Clip: process.env.CLIP_TABLE!,
  Recording: process.env.RECORDING_TABLE!,
  ScoreRef: process.env.SCOREREF_TABLE!,
  Tally: process.env.TALLY_TABLE!,
  Ranked: process.env.RANKED_TABLE!,
};

type Key = `${TargetType}#${string}`;
type Item = Record<string, AttributeValue>;

// Index names as DynamoDB has them (Amplify names an index after its fields unless the model names it).
const get = async (table: string, id: string) => (await db.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }))).Item;

async function queryAll(table: string, index: string, key: string, value: string, projection?: string) {
  const out: Item[] = [];
  let start: Item | undefined;
  do {
    const r = await db.send(
      new QueryCommand({
        TableName: table,
        IndexName: index,
        KeyConditionExpression: "#k = :v",
        ExpressionAttributeNames: { "#k": key, ...(projection ? { "#p": projection } : {}) },
        ExpressionAttributeValues: { ":v": { S: value } },
        ...(projection ? { ProjectionExpression: "#p" } : {}),
        ExclusiveStartKey: start,
      }),
    );
    out.push(...(r.Items ?? []));
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}

async function scanAll(table: string, projection: string, each: (item: Item) => Promise<void>) {
  let start: Item | undefined;
  do {
    const r: { Items?: Item[]; LastEvaluatedKey?: Item } = await db.send(new ScanCommand({ TableName: table, ProjectionExpression: projection, ExclusiveStartKey: start }));
    for (const i of r.Items ?? []) await each(i);
    start = r.LastEvaluatedKey;
  } while (start);
}

async function writeAll(requests: WriteRequest[]) {
  for (let i = 0; i < requests.length; i += 25) {
    let batch: WriteRequest[] | undefined = requests.slice(i, i + 25);
    for (let attempt = 0; batch?.length; attempt++) {
      if (attempt > 6) throw new Error(`${batch.length} rows not written`);
      const r: { UnprocessedItems?: Record<string, WriteRequest[]> } = await db.send(new BatchWriteItemCommand({ RequestItems: { [T.Ranked]: batch } }));
      batch = r.UnprocessedItems?.[T.Ranked];
      if (batch?.length) await new Promise((ok) => setTimeout(ok, 50 * 2 ** attempt));
    }
  }
}

/** What one run has looked up already: many items share a sample, and many samples a recording. */
class Lookups {
  private samples = new Map<string, Promise<Item | undefined>>();
  private documented = new Map<string, Promise<boolean>>();
  sample(id: string) {
    let p = this.samples.get(id);
    if (!p) this.samples.set(id, (p = get(T.Sample, id)));
    return p;
  }
  /** Whether a sample is hidden: it's there, and its recording isn't documented. A missing sample hides nothing. */
  async sampleHidden(id: string): Promise<boolean> {
    const s = await this.sample(id);
    if (!s) return false;
    const rec = field(s, "recordingId") ?? "";
    let p = this.documented.get(rec);
    if (!p) this.documented.set(rec, (p = rec ? get(T.Recording, rec).then(documentedRecording) : Promise.resolve(false)));
    return !(await p);
  }
}

/** Whether an item is hidden from everyone but curators (catalog.ts `hiddenIds` said the same in the browser). */
async function hiddenOf(type: TargetType, id: string, records: ItemRecords, look: Lookups): Promise<boolean> {
  if (type === "sample") return look.sampleHidden(id);
  if (type === "clip") {
    const s = field(records.clip, "sampleId");
    return !!s && look.sampleHidden(s);
  }
  const refs = await queryAll(T.ScoreRef, "scoreRefsByScoreId", "scoreId", id, "sampleId");
  const samples = new Set(refs.map((r) => field(r, "sampleId")).filter((s): s is string => !!s));
  for (const s of samples) if (await look.sampleHidden(s)) return true;
  return false;
}

/** Rebuild one item's rows. Returns the tags whose counts it may have changed. */
export async function rebuild(type: TargetType, id: string, now = new Date(), look = new Lookups()): Promise<Set<string>> {
  const records: ItemRecords = { card: await get(T.Activity, `${type}#${id}`) };
  if (type === "score" && records.card) records.score = await get(T.Score, id);
  if (type === "sample" && records.card) records.sample = await look.sample(id);
  if (type === "clip") {
    records.clip = await get(T.Clip, id);
    const sampleId = field(records.clip, "sampleId");
    if (sampleId && records.card) records.sample = await look.sample(sampleId);
  }
  const item = itemOf(type, id, records);
  // A score is hidden or not whether or not it has a card (its tab lists every score); a sample or clip matters only
  // where it shows, in the feed.
  const hidden = type === "score" || records.card ? await hiddenOf(type, id, records, look) : false;
  const [tallies, existing] = await Promise.all([item ? queryAll(T.Tally, "talliesByTarget", "targetId", id) : [], queryAll(T.Ranked, "rankedByTarget", "targetId", id, "id")]);
  const rows: RankedRow[] = [...(item ? rowsFor(item, talliesOf(tallies), now) : []), ...(hidden ? [hiddenRow({ targetType: type, targetId: id }, now.toISOString())] : [])];
  const keep = new Set(rows.map((r) => r.id));
  const had = existing.map((e) => field(e, "id")).filter((k): k is string => !!k);
  const at = now.toISOString();
  await writeAll([...rows.map((r) => ({ PutRequest: { Item: rowItem(r, at) } })), ...had.filter((k) => !keep.has(k)).map((k) => ({ DeleteRequest: { Key: { id: { S: k } } } }))]);
  // Tags it joined or left.
  const before = tagsIn(had);
  const after = tagsIn(rows.map((r) => r.list));
  return new Set([...before, ...after].filter((t) => before.has(t) !== after.has(t)));
}

/** Count a tag's scores (its all-time list) and write its row in `tags`, or remove it when nothing uses the tag. */
async function recountTag(tag: string) {
  let count = 0;
  let start: Item | undefined;
  do {
    const r = await db.send(
      new QueryCommand({
        TableName: T.Ranked,
        IndexName: "rankedByList",
        KeyConditionExpression: "#l = :l",
        ExpressionAttributeNames: { "#l": "list" },
        ExpressionAttributeValues: { ":l": { S: `tag|${tag}|all` } },
        Select: "COUNT",
        ExclusiveStartKey: start,
      }),
    );
    count += r.Count ?? 0;
    start = r.LastEvaluatedKey;
  } while (start);
  const at = new Date().toISOString();
  const row = tagRow(tag, count, at);
  if (count) await db.send(new PutItemCommand({ TableName: T.Ranked, Item: rowItem(row, at) }));
  else await db.send(new DeleteItemCommand({ TableName: T.Ranked, Key: { id: { S: row.id } } }));
}

type Table = "Activity" | "Tally" | "Score" | "Sample" | "Recording" | "ScoreRef";

/** Which table a stream record comes from (its ARN names the table). */
function tableOf(arn: string | undefined): Table | null {
  const name = arn?.split(":table/")[1]?.split("/")[0] ?? "";
  for (const t of ["Activity", "Tally", "Score", "Sample", "Recording", "ScoreRef"] as const) if (name === T[t]) return t;
  return null;
}

/** A sample and everything whose hiding follows it: its clips and the scores that use it. */
async function withDependents(sampleId: string): Promise<[TargetType, string][]> {
  const [clips, refs] = await Promise.all([queryAll(T.Clip, "clipsBySampleIdAndStart", "sampleId", sampleId, "id"), queryAll(T.ScoreRef, "scoreRefsBySampleIdAndScoreId", "sampleId", sampleId, "scoreId")]);
  return [
    ["sample", sampleId],
    ...clips.map((c) => ["clip", field(c, "id")!] as [TargetType, string]),
    ...[...new Set(refs.map((r) => field(r, "scoreId")!))].map((s) => ["score", s] as [TargetType, string]),
  ];
}

/** The items one stream record can change the rows of. */
async function affected(table: Table, rec: DynamoDBRecord): Promise<[TargetType, string][]> {
  const oldImage = rec.dynamodb?.OldImage as Item | undefined;
  const newImage = rec.dynamodb?.NewImage as Item | undefined;
  const image = newImage ?? oldImage;
  if (table === "Activity" || table === "Tally" || table === "Score") {
    const t = targetOf(table, image as never);
    return t ? [t] : [];
  }
  if (table === "ScoreRef") {
    const scores = new Set([field(oldImage, "scoreId"), field(newImage, "scoreId")].filter((s): s is string => !!s));
    return [...scores].map((s) => ["score", s]);
  }
  if (!hidingChanged(table, oldImage, newImage)) return [];
  if (table === "Sample") {
    const id = field(image, "id");
    return id ? withDependents(id) : [];
  }
  const recId = field(image, "id");
  if (!recId) return [];
  const samples = await queryAll(T.Sample, "samplesByRecordingIdAndPath", "recordingId", recId, "id");
  return (await Promise.all(samples.map((s) => withDependents(field(s, "id")!)))).flat();
}

/** The nightly pass (and the backfill): every item with a card, every score, and every tag counted afresh. */
async function everything() {
  const now = new Date();
  const look = new Lookups();
  const done = new Set<Key>();
  const tags = new Set<string>();
  const once = async (type: TargetType, id: string) => {
    const key = `${type}#${id}` as Key;
    if (done.has(key)) return;
    done.add(key);
    await rebuild(type, id, now, look);
  };
  await scanAll(T.Activity, "targetType, targetId", async (c) => {
    const t = targetOf("Activity", c);
    if (t) await once(t[0], t[1]);
  });
  await scanAll(T.Score, "id, tags", async (s) => {
    const id = field(s, "id");
    if (id) await once("score", id);
    for (const v of (s.tags && "L" in s.tags ? s.tags.L : []) ?? []) if (v && "S" in v && v.S) tags.add(v.S);
  });
  for (const r of await queryAll(T.Ranked, "rankedByList", "list", TAGS, "title")) {
    const t = field(r, "title");
    if (t) tags.add(t);
  }
  for (const t of tags) await recountTag(t);
}

export const handler = async (event: DynamoDBStreamEvent | ScheduledEvent): Promise<DynamoDBBatchResponse | void> => {
  if (!("Records" in event)) return everything();
  // A batch of changes: each item once, in order; a failure retries from its first record.
  const done = new Set<Key>();
  const look = new Lookups();
  const tags = new Set<string>();
  for (const rec of event.Records) {
    const table = tableOf(rec.eventSourceARN);
    if (!table) continue;
    try {
      for (const [type, id] of await affected(table, rec)) {
        const key = `${type}#${id}` as Key;
        if (done.has(key)) continue;
        for (const t of await rebuild(type, id, new Date(), look)) tags.add(t);
        done.add(key);
      }
    } catch (e) {
      console.error(`ranking ${table} ${rec.eventID}:`, e);
      for (const t of tags) await recountTag(t).catch(() => undefined);
      return { batchItemFailures: [{ itemIdentifier: rec.dynamodb?.SequenceNumber ?? "" }] };
    }
  }
  for (const t of tags) await recountTag(t);
  return { batchItemFailures: [] };
};
