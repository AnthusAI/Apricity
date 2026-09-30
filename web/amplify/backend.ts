import { defineBackend } from "@aws-amplify/backend";
import { Stack } from "aws-cdk-lib";
import { EventSourceMapping, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { Effect, Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { cycleUploadPolicy } from "./storage/cycle-upload-policy";
import { tally } from "./functions/tally/resource";
import { activity } from "./functions/activity/resource";
import { ranking } from "./functions/ranking/resource";
import { createSemanticAudioResources } from "./semantic/resource";

export const backend = defineBackend({
  auth,
  data,
  storage,
  tally,
  activity,
  ranking,
});

// This stack contains only the private semantic-record table. Retrieval and publisher grants are intentionally
// exported as pure helpers by semantic/resource and are attached only when their real server-side integrations land.
export const semanticAudio = createSemanticAudioResources(backend.createStack("semanticAudio"));

// Cognito group users assume their group role instead of the authenticated identity-pool role. Put these policies in
// the storage stack: attaching them directly to the auth-stack role makes auth depend on storage, while storage
// already depends on auth, which prevents CloudFormation from deploying the backend.
const cycleBucketArn = backend.storage.resources.bucket.bucketArn;
const storageStack = Stack.of(backend.storage.resources.bucket);
for (const group of ["members", "curators"] as const) {
  new Policy(storageStack, `CycleUploadFor${group}`, {
    roles: [backend.auth.resources.groups[group].role],
    statements: [
      new PolicyStatement({
        effect: Effect.ALLOW,
        ...cycleUploadPolicy(cycleBucketArn),
      }),
    ],
  });
}

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

// The ranked lists (design/scale.md) are kept by the ranking Lambda: fed by the streams of the Activity cards (an item's
// news), the Tally rows (its stars) and the Score records (a score's title, kind and tags), and run once a day to age
// the windows. The Recording, Sample and ScoreRef streams keep its `hidden` list (what uses an undocumented sample).
// Only it writes the Ranked table.
const rk = backend.ranking.resources.lambda;
for (const [env, model] of [
  ["ACTIVITY_TABLE", "Activity"],
  ["SCORE_TABLE", "Score"],
  ["SAMPLE_TABLE", "Sample"],
  ["CLIP_TABLE", "Clip"],
  ["RECORDING_TABLE", "Recording"],
  ["SCOREREF_TABLE", "ScoreRef"],
  ["TALLY_TABLE", "Tally"],
  ["RANKED_TABLE", "Ranked"],
] as const)
  backend.ranking.addEnvironment(env, tables[model].tableName);
for (const m of ["Activity", "Score", "Sample", "Clip", "Recording", "ScoreRef", "Tally"]) tables[m].grantReadData(rk);
tables["Ranked"].grantReadWriteData(rk);
// The table grants above don't reach the indexes: an item's tallies, its existing rows, a score's samples, a sample's
// clips and scores, and a recording's samples are index queries.
rk.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["dynamodb:Query"],
    resources: ["Tally", "Ranked", "Sample", "Clip", "ScoreRef"].map((m) => `${tables[m].tableArn}/index/*`),
  }),
);
const rankingFed = ["Activity", "Tally", "Score", "Recording", "Sample", "ScoreRef"];
const rankingStreams = new Policy(Stack.of(rk), "RankingReadsStreams", {
  statements: [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"],
      resources: rankingFed.map((m) => tables[m].tableStreamArn!),
    }),
  ],
});
rk.role?.attachInlinePolicy(rankingStreams);
for (const model of rankingFed) {
  const m = new EventSourceMapping(Stack.of(rk), `RankingFrom${model}`, {
    target: rk,
    eventSourceArn: tables[model].tableStreamArn,
    startingPosition: StartingPosition.LATEST,
    batchSize: 25,
    reportBatchItemFailures: true,
    retryAttempts: 10,
  });
  m.node.addDependency(rankingStreams);
}
