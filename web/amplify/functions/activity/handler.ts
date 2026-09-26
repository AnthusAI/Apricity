import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from "aws-lambda";
import { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand, type AttributeValue, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { changesOf, modelOf, type CardInfo, type Change } from "./events";

const db = new DynamoDBClient();
const ACTIVITY = process.env.ACTIVITY_TABLE!;
const EVENTS = process.env.EVENT_TABLE!;
const TABLE_OF: Record<string, string | undefined> = { score: process.env.SCORE_TABLE, sample: process.env.SAMPLE_TABLE, clip: process.env.CLIP_TABLE };

// Each change is one transaction: its line (written only if new, or removed only if there) and its card (moved up,
// counts adjusted). A line already written or already gone cancels the transaction: that change was applied before,
// so a retried batch changes nothing twice. Records are applied in order; a failure reports that record (and so
// everything after it) for a retry, as the tally Lambda does.
export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  for (const rec of event.Records) {
    try {
      const model = modelOf(rec.eventSourceARN ?? "");
      const changes = changesOf(model, rec.eventName as "INSERT" | "MODIFY" | "REMOVE", rec.dynamodb?.OldImage as any, rec.dynamodb?.NewImage as any);
      for (const c of changes) await apply(c);
    } catch (e) {
      console.error("activity failed", rec.dynamodb?.SequenceNumber, e);
      return { batchItemFailures: [{ itemIdentifier: rec.dynamodb!.SequenceNumber! }] };
    }
  }
  return { batchItemFailures: [] };
};

const S = (v: string): AttributeValue => ({ S: v });

/** Write one change: its line, then its card (exported for the backfill script). */
export async function apply(c: Change) {
  const now = new Date().toISOString();
  const card = await cardInfo(c);
  const line: TransactWriteItem =
    c.line.op === "remove"
      ? { Delete: { TableName: EVENTS, Key: { id: S(c.line.id) }, ConditionExpression: "attribute_exists(id)" } }
      : {
          Put: {
            TableName: EVENTS,
            Item: {
              id: S(c.line.id),
              __typename: S("ActivityEvent"),
              targetKey: S(c.key),
              at: S(c.line.at),
              what: S(c.line.what!),
              ...(c.line.by ? { by: S(c.line.by) } : {}),
              ...(c.line.stars !== undefined ? { stars: { N: String(c.line.stars) } } : {}),
              ...(c.line.commentId ? { commentId: S(c.line.commentId) } : {}),
              createdAt: S(now),
              updatedAt: S(now),
            },
            ...(c.line.overwrite ? {} : { ConditionExpression: "attribute_not_exists(id)" }),
          },
        };

  const set = ["feed = :feed", "targetType = :tt", "targetId = :ti", "#tn = :tn", "updatedAt = :now", "createdAt = if_not_exists(createdAt, :now)"];
  const values: Record<string, AttributeValue> = { ":feed": S("all"), ":tt": S(c.targetType), ":ti": S(c.targetId), ":tn": S("Activity"), ":now": S(now) };
  const names: Record<string, string> = { "#tn": "__typename" };
  // The card's own facts: set when the item says them (made, changed), otherwise kept.
  for (const [k, v] of Object.entries({ title: card.title, kind: card.kind, owner: card.owner, samplePath: card.samplePath })) {
    if (!v) continue;
    names[`#${k}`] = k;
    values[`:${k}`] = S(v);
    set.push(`#${k} = ${c.card?.[k as keyof CardInfo] ? `:${k}` : `if_not_exists(#${k}, :${k})`}`);
  }
  if (c.bump) {
    set.push("lastAt = :at", "lastWhat = :what", "lastBy = :by");
    values[":at"] = S(c.line.at);
    values[":what"] = S(c.line.what!);
    values[":by"] = S(c.line.by ?? "");
  } else set.push("lastAt = if_not_exists(lastAt, :now)");
  const add: string[] = [];
  for (const [k, n] of Object.entries(c.counts ?? {})) {
    if (!n) continue;
    names[`#${k}`] = k;
    values[`:${k}`] = { N: String(n) };
    add.push(`#${k} :${k}`);
  }
  const update: TransactWriteItem = {
    Update: {
      TableName: ACTIVITY,
      Key: { id: S(c.key) },
      UpdateExpression: `SET ${set.join(", ")}${add.length ? ` ADD ${add.join(", ")}` : ""}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
  try {
    await db.send(new TransactWriteItemsCommand({ TransactItems: [line, update] }));
  } catch (e) {
    // The line's condition failed: this change is already on the page.
    if ((e as { name?: string }).name === "TransactionCanceledException" && /ConditionalCheckFailed/.test(String((e as Error).message) + JSON.stringify((e as any).CancellationReasons ?? ""))) return;
    throw e;
  }
}

/** What the card needs to show: from the change itself, else from the card or the item's own record (a rating or a
 *  comment on an item made before the Activity page existed). A clip also needs its sample's path, to open it. */
async function cardInfo(c: Change): Promise<CardInfo & { samplePath?: string }> {
  let info: CardInfo & { samplePath?: string } = { ...c.card };
  if (!info.title) {
    const have = await db.send(new GetItemCommand({ TableName: ACTIVITY, Key: { id: S(c.key) }, ProjectionExpression: "title" }));
    if (have.Item?.title?.S) return {};
    const table = TABLE_OF[c.targetType];
    const item = table ? (await db.send(new GetItemCommand({ TableName: table, Key: { id: S(c.targetId) } }))).Item : undefined;
    if (item) {
      info = {
        title: item.title?.S ?? item.name?.S,
        kind: c.targetType === "score" ? (item.kind?.S ?? "song") : c.targetType,
        owner: item.owner?.S,
        sampleId: item.sampleId?.S,
      };
    }
  }
  if (c.targetType === "clip" && info.sampleId && TABLE_OF.sample) {
    const sample = (await db.send(new GetItemCommand({ TableName: TABLE_OF.sample, Key: { id: S(info.sampleId) }, ProjectionExpression: "#p", ExpressionAttributeNames: { "#p": "path" } }))).Item;
    if (sample?.path?.S) info.samplePath = sample.path.S;
  }
  return info;
}
