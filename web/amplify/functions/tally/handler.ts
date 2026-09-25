import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from "aws-lambda";
import { DynamoDBClient, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { ratingOf, tallyDeltas, tallyId } from "./deltas";

const db = new DynamoDBClient();
const TABLE = process.env.TALLY_TABLE!;

// Each record's deltas are written in one transaction, and records are applied in order; a failure reports that record
// (and so everything after it) for a retry (reportBatchItemFailures). A retry never adds the same rating twice.
export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  for (const rec of event.Records) {
    try {
      const before = ratingOf(rec.dynamodb?.OldImage as any);
      const after = ratingOf(rec.dynamodb?.NewImage as any);
      const now = new Date().toISOString();
      const deltas = tallyDeltas(before, after);
      if (!deltas.length) continue;
      await db.send(
        new TransactWriteItemsCommand({
          TransactItems: deltas.map((d) => ({
            Update: {
              TableName: TABLE,
              Key: { id: { S: tallyId(d) } },
              UpdateExpression:
                "ADD #count :c, #sum :s SET targetType = :tt, targetId = :ti, #day = :d, #tn = :tn, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)",
              ExpressionAttributeNames: { "#count": "count", "#sum": "sum", "#day": "day", "#tn": "__typename" },
              ExpressionAttributeValues: {
                ":c": { N: String(d.count) },
                ":s": { N: String(d.sum) },
                ":tt": { S: d.targetType },
                ":ti": { S: d.targetId },
                ":d": { S: d.day },
                ":tn": { S: "Tally" },
                ":now": { S: now },
              },
            },
          })),
        }),
      );
    } catch (e) {
      console.error("tally failed", rec.dynamodb?.SequenceNumber, e);
      return { batchItemFailures: [{ itemIdentifier: rec.dynamodb!.SequenceNumber! }] };
    }
  }
  return { batchItemFailures: [] };
};
