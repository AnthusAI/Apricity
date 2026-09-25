import { defineBackend } from "@aws-amplify/backend";
import { Stack } from "aws-cdk-lib";
import { EventSourceMapping, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { Effect, Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { tally } from "./functions/tally/resource";

export const backend = defineBackend({
  auth,
  data,
  storage,
  tally,
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
