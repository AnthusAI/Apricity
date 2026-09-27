import { defineBackend } from "@aws-amplify/backend";
import { Stack } from "aws-cdk-lib";
import { EventSourceMapping, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { Effect, Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { tally } from "./functions/tally/resource";
import { activity } from "./functions/activity/resource";
import { voiceRequest } from "./functions/voice-request/resource";
import { voiceIngest } from "./functions/voice-ingest/resource";
import { Rule } from "aws-cdk-lib/aws-events";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { SpeechRenderer } from "@anthusai/auritus-construct";

export const backend = defineBackend({
  auth,
  data,
  storage,
  tally,
  activity,
  voiceRequest,
  voiceIngest,
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

// Voice lines: a curator asks for one (requestVoiceLine), Auritus renders it on a GPU in this
// account (its SpeechRenderer: AWS Batch that scales to zero), and voice-ingest turns the result
// into a generated Sample with phrase clips. The worker image is the Auritus release this pins.
const AURITUS_VERSION = "0.27.1";
const voiceStack = backend.createStack("Voice");
const files = backend.storage.resources.bucket;

// The GPU jobs run in an existing VPC (the account's default one): they only need outbound internet
// for the image and model weights, and the account's VPC quota is used up. Amplify stacks can't
// look a VPC up, so the build names it: APRICITY_VOICE_VPC_ID, and APRICITY_VOICE_SUBNETS as
// comma-separated public subnet:availability-zone pairs, in zones that offer g4dn.xlarge.
function voiceVpc() {
  const vpcId = process.env.APRICITY_VOICE_VPC_ID?.trim();
  const pairs = (process.env.APRICITY_VOICE_SUBNETS ?? "")
    .split(",")
    .map((p) => p.trim().split(":"))
    .filter((p) => p.length === 2 && p[0] && p[1]);
  if (!vpcId || !pairs.length) {
    throw new Error(
      "Voice rendering needs a VPC: set APRICITY_VOICE_VPC_ID and APRICITY_VOICE_SUBNETS " +
        "(e.g. subnet-0123:us-east-1a,subnet-4567:us-east-1b) in the build environment.",
    );
  }
  return Vpc.fromVpcAttributes(voiceStack, "VoiceVpc", {
    vpcId,
    availabilityZones: pairs.map(([, az]) => az),
    publicSubnetIds: pairs.map(([subnet]) => subnet),
  });
}
const renderer = new SpeechRenderer(voiceStack, "Renderer", {
  name: "apricity-voice",
  vpc: voiceVpc(),
  image: `${voiceStack.account}.dkr.ecr.${voiceStack.region}.amazonaws.com/auritus-worker:${AURITUS_VERSION}`,
  outputBucket: files,
  outputPrefix: "voice-renders/",
  allowedBackends: ["kokoro"],
  // Tag-scoped to the renderer's GPUs; needs the auritus:renderer cost allocation tag activated.
  dailyBudgetUsd: 10,
});

const voiceReq = backend.voiceRequest.resources.lambda;
backend.voiceRequest.addEnvironment("JOB_TABLE", tables["Job"].tableName);
backend.voiceRequest.addEnvironment("SAMPLE_TABLE", tables["Sample"].tableName);
backend.voiceRequest.addEnvironment("STATE_MACHINE_ARN", renderer.stateMachine.stateMachineArn);
tables["Job"].grantWriteData(voiceReq);
tables["Sample"].grantReadData(voiceReq);
renderer.grantStartExecution(voiceReq);

const voiceIng = backend.voiceIngest.resources.lambda;
backend.voiceIngest.addEnvironment("BUCKET", files.bucketName);
backend.voiceIngest.addEnvironment("RENDER_PREFIX", renderer.outputPrefix);
for (const m of ["Job", "Recording", "Sample", "Clip"]) {
  backend.voiceIngest.addEnvironment(`${m.toUpperCase()}_TABLE`, tables[m].tableName);
}
tables["Job"].grantReadWriteData(voiceIng);
for (const m of ["Recording", "Sample", "Clip"]) tables[m].grantWriteData(voiceIng);
files.grantRead(voiceIng, `${renderer.outputPrefix}*`);
for (const prefix of ["files/audio/*", "files/analysis/*", "Recording/*", "Sample/*", "Clip/*"]) files.grantPut(voiceIng, prefix);
new Rule(Stack.of(voiceIng), "VoiceRenderFinished", {
  eventPattern: {
    source: ["aws.states"],
    detailType: ["Step Functions Execution Status Change"],
    detail: {
      stateMachineArn: [renderer.stateMachine.stateMachineArn],
      status: ["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"],
    },
  },
  targets: [new LambdaFunction(voiceIng, { retryAttempts: 4 })],
});
