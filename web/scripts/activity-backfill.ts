// Fill the Activity page with what happened before it existed: every score, sample, people's clip, rating and comment,
// run through the activity Lambda's own logic (amplify/functions/activity), oldest first, so each card ends on its
// latest activity. Safe to run again: every line has the same id the Lambda gives it, so nothing counts twice.
//
//   npx tsx scripts/activity-backfill.ts            # a dry run: what it would write
//   npx tsx scripts/activity-backfill.ts --write    # write it (production tables; AWS credentials from your profile)

import { DynamoDBClient, ListTablesCommand, ScanCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { changesOf, type Change, type Image } from "../amplify/functions/activity/events";

const API = process.env.APRICITY_API_ID ?? "nd3uprkpafehvjszmnn44mr7fi";
const write = process.argv.includes("--write");
const db = new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" });

const tables = new Map<string, string>();
let start: string | undefined;
do {
  const r = await db.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
  for (const t of r.TableNames ?? []) {
    const m = new RegExp(`^([A-Za-z]+)-${API}-NONE$`).exec(t);
    if (m) tables.set(m[1], t);
  }
  start = r.LastEvaluatedTableName;
} while (start);
// A dry run before the deploy has no Activity or Comment tables yet; writing needs them all.
for (const m of ["Activity", "ActivityEvent", "Score", "Sample", "Clip", "Rating", "Comment"]) if (write && !tables.has(m)) throw new Error(`no ${m} table for API ${API}: deploy first`);

process.env.ACTIVITY_TABLE = tables.get("Activity");
process.env.EVENT_TABLE = tables.get("ActivityEvent");
process.env.SCORE_TABLE = tables.get("Score");
process.env.SAMPLE_TABLE = tables.get("Sample");
process.env.CLIP_TABLE = tables.get("Clip");
const { apply } = await import("../amplify/functions/activity/handler");

async function scan(table: string): Promise<Record<string, AttributeValue>[]> {
  const out: Record<string, AttributeValue>[] = [];
  let key: Record<string, AttributeValue> | undefined;
  do {
    const r = await db.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }));
    out.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return out;
}

const changes: Change[] = [];
for (const model of ["Score", "Sample", "Clip", "Rating", "Comment"]) {
  if (!tables.has(model)) {
    console.log(`${model}: no table yet`);
    continue;
  }
  const rows = await scan(tables.get(model)!);
  for (const row of rows) changes.push(...changesOf(model, "INSERT", null, row as Image));
  console.log(`${model}: ${rows.length} records`);
}
changes.sort((a, b) => a.line.at.localeCompare(b.line.at));
const cards = new Set(changes.map((c) => c.key));
console.log(`${changes.length} lines on ${cards.size} cards${write ? "" : " (dry run; add --write to write them)"}`);
if (write) {
  let n = 0;
  for (const c of changes) {
    await apply(c);
    if (++n % 50 === 0) console.log(`  ${n} of ${changes.length}`);
  }
  console.log("done");
}
