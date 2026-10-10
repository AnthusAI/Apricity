import type { EventBridgeEvent } from "aws-lambda";
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { planFailure, planIngest, type SpeechMeta, type VoiceJobInput } from "./ingest";

const s3 = new S3Client();
const db = new DynamoDBClient();
const BUCKET = process.env.BUCKET!;
const PREFIX = process.env.RENDER_PREFIX!; // e.g. "voice-renders/"
const TABLES: Record<string, string> = {
  Job: process.env.JOB_TABLE!,
  Recording: process.env.RECORDING_TABLE!,
  Sample: process.env.SAMPLE_TABLE!,
  Clip: process.env.CLIP_TABLE!,
};

/** A JSON value as a DynamoDB attribute (the shapes AppSync writes). */
function toAttr(v: unknown): AttributeValue {
  if (v === null || v === undefined) return { NULL: true };
  if (typeof v === "string") return { S: v };
  if (typeof v === "number") return { N: String(v) };
  if (typeof v === "boolean") return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(toAttr) };
  return { M: Object.fromEntries(Object.entries(v as object).filter(([, x]) => x !== undefined).map(([k, x]) => [k, toAttr(x)])) };
}

async function readObject(key: string): Promise<Uint8Array | null> {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await out.Body!.transformToByteArray();
  } catch (e: any) {
    if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

async function updateJob(update: { id: string; state: string; error: string | null; updatedAt: string; sampleId?: string }) {
  const names: Record<string, string> = { "#state": "state", "#error": "error", "#updatedAt": "updatedAt" };
  const values: Record<string, AttributeValue> = { ":state": toAttr(update.state), ":error": toAttr(update.error), ":updatedAt": toAttr(update.updatedAt) };
  let expr = "SET #state = :state, #error = :error, #updatedAt = :updatedAt";
  if (update.sampleId) {
    names["#sampleId"] = "sampleId";
    values[":sampleId"] = toAttr(update.sampleId);
    expr += ", #sampleId = :sampleId";
  }
  await db.send(
    new UpdateItemCommand({
      TableName: TABLES.Job,
      Key: { id: { S: update.id } },
      UpdateExpression: expr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

interface ExecutionStatusChange {
  status: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED" | string;
  input: string;
}

// A render finished (the SpeechRenderer state machine's status-change event): turn its output into a
// generated Sample, or record why it failed on the Job. Retried by EventBridge on error; every
// write is idempotent (ids come from content, the shared Recording is written only if missing).
export const handler = async (event: EventBridgeEvent<"Step Functions Execution Status Change", ExecutionStatusChange>) => {
  const { jobId } = JSON.parse(event.detail.input) as { jobId: string };
  const prefix = `${PREFIX}${jobId}/`;
  const now = new Date().toISOString();

  if (event.detail.status !== "SUCCEEDED") {
    const raw = await readObject(`${prefix}error.json`);
    const error = raw ? JSON.parse(new TextDecoder().decode(raw)) : null;
    await updateJob(planFailure({ jobId, error, now }));
    return { jobId, state: "failed" };
  }

  const got = await db.send(new GetItemCommand({ TableName: TABLES.Job, Key: { id: { S: jobId } } }));
  const inputAttr = got.Item?.input?.S;
  if (!inputAttr) throw new Error(`job ${jobId} has no input`);
  const input = JSON.parse(inputAttr) as VoiceJobInput;
  const [wav, meta] = await Promise.all([readObject(`${prefix}speech.wav`), readObject(`${prefix}speech.json`)]);
  if (!wav || !meta) {
    await updateJob(planFailure({ jobId, error: { error: "MissingOutput", message: `no speech.wav or speech.json under ${prefix}` }, now }));
    return { jobId, state: "failed" };
  }
  const speech = JSON.parse(new TextDecoder().decode(meta)) as SpeechMeta;
  const plan = planIngest({ job: { id: jobId, input }, wav, speech, now });

  for (const f of plan.files) {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: f.key, Body: f.body, ContentType: f.contentType }));
  }
  for (const r of plan.records) {
    try {
      await db.send(
        new PutItemCommand({
          TableName: TABLES[r.model],
          Item: (toAttr(r.item) as { M: Record<string, AttributeValue> }).M,
          ...(r.onlyIfMissing ? { ConditionExpression: "attribute_not_exists(id)" } : {}),
        }),
      );
    } catch (e: any) {
      if (!(r.onlyIfMissing && e?.name === "ConditionalCheckFailedException")) throw e;
    }
  }
  await updateJob(plan.job);
  return { jobId, state: "done", sampleId: plan.sampleId };
};
