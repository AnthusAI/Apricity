import { CfnOutput, CfnParameter, Fn, Stack } from "aws-cdk-lib";
import { CfnApi, CfnIntegration, CfnRoute, CfnStage } from "aws-cdk-lib/aws-apigatewayv2";
import { CfnPermission } from "aws-cdk-lib/aws-lambda";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

/** The deliberately small surface supplied by Amplify's real Lambda resource. */
export type SemanticRuntimeLambda = IFunction & Readonly<{ addToRolePolicy(statement: PolicyStatement): unknown }>;

export type SemanticRuntimeDeployment = Readonly<{
  lambda: SemanticRuntimeLambda;
  addEnvironment(key: string, value: string): unknown;
  semanticTableName: string;
  vectorIndexName: string;
  vectorIndexArn: string;
  sampleIndexArn: string;
  sampleTableName: string;
  sampleTableArn: string;
  recordingTableName: string;
  recordingTableArn: string;
  clipTableName: string;
  clipTableArn: string;
  bucketName: string;
  bucketArn: string;
  userPoolId: string;
  userPoolClientId: string;
}>;

export type SemanticRuntimeOutputs = Readonly<{
  api: CfnApi;
  url: string;
  searchEnabled: string;
  relatedEnabled: string;
  processingFingerprint: string;
}>;

/**
 * Wires the private semantic runtime without guessing a public origin.  It is a
 * standalone CDK unit so its topology can be synthesized without Amplify context.
 */
export function createSemanticRuntimeDeployment(scope: Construct, values: SemanticRuntimeDeployment): SemanticRuntimeOutputs {
  const stack = Stack.of(scope);
  const allowedOrigins = new CfnParameter(scope, "SemanticAllowedOrigins", { type: "String", default: "" });
  const searchEnabled = new CfnParameter(scope, "SemanticSearchEnabled", { type: "String", default: "false", allowedValues: ["true", "false"] });
  const relatedEnabled = new CfnParameter(scope, "SemanticRelatedEnabled", { type: "String", default: "false", allowedValues: ["true", "false"] });
  const processingFingerprint = new CfnParameter(scope, "SemanticProcessingFingerprint", { type: "String", default: "" });
  for (const [key, value] of [
    ["SEMANTIC_TABLE", values.semanticTableName], ["SEMANTIC_VECTOR_INDEX", values.vectorIndexName],
    ["SAMPLE_TABLE", values.sampleTableName], ["RECORDING_TABLE", values.recordingTableName], ["CLIP_TABLE", values.clipTableName],
    ["STORAGE_BUCKET", values.bucketName], ["COGNITO_USER_POOL_ID", values.userPoolId], ["COGNITO_USER_POOL_CLIENT_ID", values.userPoolClientId],
    ["SEMANTIC_ALLOWED_ORIGINS", allowedOrigins.valueAsString], ["SEMANTIC_SEARCH_ENABLED", searchEnabled.valueAsString],
    ["SEMANTIC_RELATED_ENABLED", relatedEnabled.valueAsString], ["SEMANTIC_PROCESSING_FINGERPRINT", processingFingerprint.valueAsString],
  ] as const) values.addEnvironment(key, value);

  values.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.ALLOW, actions: ["dynamodb:SearchVectors"], resources: [values.vectorIndexArn] }));
  values.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.ALLOW, actions: ["dynamodb:Query"], resources: [values.sampleIndexArn] }));
  values.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.ALLOW, actions: ["dynamodb:GetItem"], resources: [values.sampleTableArn, values.recordingTableArn, values.clipTableArn] }));
  values.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.ALLOW, actions: ["s3:GetObject"], resources: [Fn.join("", [values.bucketArn, "/files/analysis/*"])] }));

  const api = new CfnApi(scope, "SemanticHttpApi", { protocolType: "HTTP", name: "apricity-semantic" });
  const integration = new CfnIntegration(scope, "SemanticLambdaIntegration", {
    apiId: api.ref, integrationType: "AWS_PROXY",
    integrationUri: Fn.join("", ["arn:", stack.partition, ":apigateway:", stack.region, ":lambda:path/2015-03-31/functions/", values.lambda.functionArn, "/invocations"]),
    payloadFormatVersion: "2.0",
  });
  const stage = new CfnStage(scope, "SemanticDefaultStage", { apiId: api.ref, stageName: "$default", autoDeploy: true });
  for (const [id, routeKey, method, path] of [
    ["Search", "POST /semantic/search", "POST", "semantic/search"], ["Related", "POST /semantic/related", "POST", "semantic/related"],
    ["SearchPreflight", "OPTIONS /semantic/search", "OPTIONS", "semantic/search"], ["RelatedPreflight", "OPTIONS /semantic/related", "OPTIONS", "semantic/related"],
  ] as const) {
    const route = new CfnRoute(scope, `Semantic${id}Route`, { apiId: api.ref, routeKey, target: Fn.join("", ["integrations/", integration.ref]) });
    route.addResourceDependency(integration);
    const permission = new CfnPermission(scope, `Semantic${id}Permission`, {
      action: "lambda:InvokeFunction", functionName: values.lambda.functionName, principal: "apigateway.amazonaws.com",
      sourceArn: Fn.join("", ["arn:", stack.partition, ":execute-api:", stack.region, ":", stack.account, ":", api.ref, "/$default/", method, "/", path]),
    });
    permission.addResourceDependency(stage);
  }
  // This is a base, rather than a complete operation URL: browser transports append /search or /related.
  const url = Fn.join("", [api.attrApiEndpoint, "/semantic"]);
  new CfnOutput(scope, "SemanticUrl", { value: url });
  return { api, url, searchEnabled: searchEnabled.valueAsString, relatedEnabled: relatedEnabled.valueAsString, processingFingerprint: processingFingerprint.valueAsString };
}
