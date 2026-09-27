// Keeps the Ranked table (design/scale.md §2.2): whenever an item's Activity card, its tallies or (a score's) record
// changes, its rows are rebuilt: every list it's in, in its current place, stale rows (a removed tag, a gone item)
// deleted. Once a day (EventBridge) every item in the feed is rebuilt, so freshness and the week and month windows age.
// Rebuilding is idempotent: a retry, or the nightly pass, never leaves a row twice.

import type { DynamoDBBatchResponse, DynamoDBStreamEvent, ScheduledEvent } from "aws-lambda";
import { BatchWriteItemCommand, DynamoDBClient, GetItemCommand, QueryCommand, ScanCommand, type AttributeValue, type WriteRequest } from "@aws-sdk/client-dynamodb";
import { rowsFor, type TargetType } from "../../../src/data/ranked";
import { itemOf, rowItem, talliesOf, targetOf, type ItemRecords } from "./item";

const db = new DynamoDBClient();
const T = {
  Activity: process.env.ACTIVITY_TABLE!,
  Score: process.env.SCORE_TABLE!,
  Sample: process.env.SAMPLE_TABLE!,
  Clip: process.env.CLIP_TABLE!,
  Tally: process.env.TALLY_TABLE!,
  Ranked: process.env.RANKED_TABLE!,
};

type Key = `${TargetType}#${string}`;

const get = async (table: string, id: string) => (await db.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }))).Item;

async function queryAll(table: string, index: string, key: string, value: string, projection?: string) {
  const out: Record<string, AttributeValue>[] = [];
  let start: Record<string, AttributeValue> | undefined;
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

/** Rebuild one item's rows. */
export async function rebuild(type: TargetType, id: string, now = new Date()) {
  const records: ItemRecords = { card: await get(T.Activity, `${type}#${id}`) };
  if (records.card) {
    if (type === "score") records.score = await get(T.Score, id);
    if (type === "sample") records.sample = await get(T.Sample, id);
    if (type === "clip") {
      records.clip = await get(T.Clip, id);
      const sampleId = records.clip?.sampleId && "S" in records.clip.sampleId ? records.clip.sampleId.S : undefined;
      if (sampleId) records.sample = await get(T.Sample, sampleId);
    }
  }
  const item = itemOf(type, id, records);
  const [tallies, existing] = await Promise.all([item ? queryAll(T.Tally, "talliesByTarget", "targetId", id) : [], queryAll(T.Ranked, "rankedByTarget", "targetId", id, "id")]);
  const rows = item ? rowsFor(item, talliesOf(tallies), now) : [];
  const keep = new Set(rows.map((r) => r.id));
  const at = now.toISOString();
  await writeAll([
    ...rows.map((r) => ({ PutRequest: { Item: rowItem(r, at) } })),
    ...existing
      .map((e) => (e.id && "S" in e.id ? e.id.S : undefined))
      .filter((k): k is string => !!k && !keep.has(k))
      .map((k) => ({ DeleteRequest: { Key: { id: { S: k } } } })),
  ]);
}

/** Which table a stream record comes from (its ARN names the table). */
function tableOf(arn: string | undefined): "Activity" | "Tally" | "Score" | null {
  const name = arn?.split(":table/")[1]?.split("/")[0] ?? "";
  if (name === T.Activity) return "Activity";
  if (name === T.Tally) return "Tally";
  if (name === T.Score) return "Score";
  return null;
}

export const handler = async (event: DynamoDBStreamEvent | ScheduledEvent): Promise<DynamoDBBatchResponse | void> => {
  if (!("Records" in event)) {
    // The nightly pass: every item with a card.
    let start: Record<string, AttributeValue> | undefined;
    const now = new Date();
    do {
      const r: { Items?: Record<string, AttributeValue>[]; LastEvaluatedKey?: Record<string, AttributeValue> } = await db.send(
        new ScanCommand({ TableName: T.Activity, ProjectionExpression: "targetType, targetId", ExclusiveStartKey: start }),
      );
      for (const c of r.Items ?? []) {
        const t = targetOf("Activity", c);
        if (t) await rebuild(t[0], t[1], now);
      }
      start = r.LastEvaluatedKey;
    } while (start);
    return;
  }
  // A batch of changes: each item once, in order; a failure retries from its first record.
  const done = new Set<Key>();
  for (const rec of event.Records) {
    const table = tableOf(rec.eventSourceARN);
    const t = table ? (targetOf(table, (rec.dynamodb?.NewImage ?? rec.dynamodb?.OldImage) as never) ?? null) : null;
    if (!t) continue;
    const key = `${t[0]}#${t[1]}` as Key;
    if (done.has(key)) continue;
    try {
      await rebuild(t[0], t[1]);
      done.add(key);
    } catch (e) {
      console.error(`ranking ${key}:`, e);
      return { batchItemFailures: [{ itemIdentifier: rec.dynamodb?.SequenceNumber ?? "" }] };
    }
  }
  return { batchItemFailures: [] };
};
