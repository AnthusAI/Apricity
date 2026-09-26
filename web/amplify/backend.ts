import { defineBackend } from "@aws-amplify/backend";
import { Stack } from "aws-cdk-lib";
import { EventSourceMapping, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { Effect, Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { tally } from "./functions/tally/resource";
import { activity } from "./functions/activity/resource";

export const backend = defineBackend({
  auth,
  data,
  storage,
  tally,
  activity,
});

// Ratings are private; their public tallies are kept by the tally Lambda, fed by the Rating table's stream (Amplify
// model tables stream new and old images). Only the Lambda writes the Tally table.
const ratings = backend.data.resources.tables["Rating"];
const tallies = backend.data.resources.tables["Tally"];
const fn = backend.tally.resources.lambda;
backend.tally.addEnvironment("TALLY_TABLE", tallies.tableName);
tallies.grantReadWriteData(fn);
const streamRead = new Policy(Stack.of(ratings), "TallyReadsRatingStream", {
  statements: [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"],
      resources: [ratings.tableStreamArn!],
    }),
  ],
});
fn.role?.attachInlinePolicy(streamRead);
const mapping = new EventSourceMapping(Stack.of(ratings), "TallyFromRatings", {
  target: fn,
  eventSourceArn: ratings.tableStreamArn,
  startingPosition: StartingPosition.LATEST,
  batchSize: 25,
  reportBatchItemFailures: true,
  retryAttempts: 10,
});
mapping.node.addDependency(streamRead);

// The Activity page is kept by the activity Lambda, fed by the streams of everything it reports: new scores, samples
// and clips, changed scores, ratings and comments. Only it writes the Activity and ActivityEvent tables; it reads the
// items' own tables for their titles.
const tables = backend.data.resources.tables;
const act = backend.activity.resources.lambda;
backend.activity.addEnvironment("ACTIVITY_TABLE", tables["Activity"].tableName);
backend.activity.addEnvironment("EVENT_TABLE", tables["ActivityEvent"].tableName);
backend.activity.addEnvironment("SCORE_TABLE", tables["Score"].tableName);
backend.activity.addEnvironment("SAMPLE_TABLE", tables["Sample"].tableName);
backend.activity.addEnvironment("CLIP_TABLE", tables["Clip"].tableName);
tables["Activity"].grantReadWriteData(act);
tables["ActivityEvent"].grantReadWriteData(act);
for (const m of ["Score", "Sample", "Clip"]) tables[m].grantReadData(act);
const fed = ["Score", "Sample", "Clip", "Rating", "Comment"];
const activityStreams = new Policy(Stack.of(act), "ActivityReadsStreams", {
  statements: [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"],
      resources: fed.map((m) => tables[m].tableStreamArn!),
    }),
  ],
});
act.role?.attachInlinePolicy(activityStreams);
for (const model of fed) {
  const m = new EventSourceMapping(Stack.of(act), `ActivityFrom${model}`, {
    target: act,
    eventSourceArn: tables[model].tableStreamArn,
    startingPosition: StartingPosition.LATEST,
    batchSize: 25,
    reportBatchItemFailures: true,
    retryAttempts: 10,
  });
  m.node.addDependency(activityStreams);
}
