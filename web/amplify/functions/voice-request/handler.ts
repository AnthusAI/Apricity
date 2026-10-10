import type { AppSyncResolverEvent } from "aws-lambda";
import { randomUUID } from "node:crypto";
import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { planRequest, RequestError, type RequestArgs } from "./request";

const db = new DynamoDBClient();
const sfn = new SFNClient();
const JOB_TABLE = process.env.JOB_TABLE!;
const SAMPLE_TABLE = process.env.SAMPLE_TABLE!;
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;

// requestVoiceLine (curators only, by the schema): queue a voice Job and start its render. The
// voice-ingest function finishes it when the render does.
export const handler = async (event: AppSyncResolverEvent<RequestArgs>) => {
  const identity = (event.identity ?? {}) as { username?: string; sub?: string };
  const requester = identity.username ?? identity.sub ?? "unknown";
  const now = new Date().toISOString();
  const plan = planRequest({ args: event.arguments, requester, jobId: randomUUID(), now });

  // A name is the sample's path; never replace a line someone already made.
  const taken = await db.send(
    new QueryCommand({
      TableName: SAMPLE_TABLE,
      IndexName: "samplesByPath",
      KeyConditionExpression: "#path = :path",
      ExpressionAttributeNames: { "#path": "path" },
      ExpressionAttributeValues: { ":path": { S: plan.path } },
      Limit: 1,
    }),
  );
  if (taken.Items?.length) throw new RequestError(`name: ${plan.path} is taken; choose another name`);

  await db.send(
    new PutItemCommand({
      TableName: JOB_TABLE,
      Item: Object.fromEntries(Object.entries(plan.job).map(([k, v]) => [k, { S: String(v) }])),
      ConditionExpression: "attribute_not_exists(id)",
    }),
  );
  await sfn.send(new StartExecutionCommand({ stateMachineArn: STATE_MACHINE_ARN, name: plan.job.id, input: JSON.stringify(plan.render) }));
  return plan.job;
};
