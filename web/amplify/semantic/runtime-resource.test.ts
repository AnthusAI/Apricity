import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Table, AttributeType, BillingMode } from "aws-cdk-lib/aws-dynamodb";
import { Function as LambdaFunction, Runtime, Code } from "aws-cdk-lib/aws-lambda";
import { CfnUserPool, CfnUserPoolClient } from "aws-cdk-lib/aws-cognito";
import { createSemanticAudioResources } from "./resource";
import { createSemanticRuntimeDeployment } from "./runtime-resource";

test("semantic runtime CDK wiring synthesizes only the guarded API, exact permissions, parameters, and no stack cycle", () => {
  const app = new App();
  const data = new Stack(app, "Data", { env: { account: "000000000000", region: "us-east-1" } });
  const runtime = new Stack(app, "Runtime", { env: { account: "000000000000", region: "us-east-1" } });
  const semantic = createSemanticAudioResources(data);
  const sample = new Table(data, "Sample", { partitionKey: { name: "id", type: AttributeType.STRING }, billingMode: BillingMode.PAY_PER_REQUEST });
  const recording = new Table(data, "Recording", { partitionKey: { name: "id", type: AttributeType.STRING }, billingMode: BillingMode.PAY_PER_REQUEST });
  const clip = new Table(data, "Clip", { partitionKey: { name: "id", type: AttributeType.STRING }, billingMode: BillingMode.PAY_PER_REQUEST });
  const bucket = new Bucket(data, "Files");
  const pool = new CfnUserPool(data, "Pool"); const client = new CfnUserPoolClient(data, "Client", { userPoolId: pool.ref });
  const lambda = new LambdaFunction(runtime, "Semantic", { runtime: Runtime.NODEJS_22_X, handler: "index.handler", code: Code.fromInline("exports.handler=()=>{}") });
  const output = createSemanticRuntimeDeployment(runtime, {
    lambda, addEnvironment: lambda.addEnvironment.bind(lambda), semanticTableName: semantic.tableName, vectorIndexName: semantic.indexName, vectorIndexArn: semantic.vectorIndexArn, sampleIndexArn: semantic.sampleIndexArn,
    sampleTableName: sample.tableName, sampleTableArn: sample.tableArn, recordingTableName: recording.tableName, recordingTableArn: recording.tableArn,
    clipTableName: clip.tableName, clipTableArn: clip.tableArn, bucketName: bucket.bucketName, bucketArn: bucket.bucketArn, userPoolId: pool.ref, userPoolClientId: client.ref,
  });
  assert.notEqual(output.searchEnabled, output.relatedEnabled, "independent flags have distinct deployment parameters");
  assert.doesNotThrow(() => app.synth(), "cross-stack references must remain acyclic");

  const template = Template.fromStack(runtime).toJSON() as { Resources: Record<string, any>; Parameters: Record<string, any>; Outputs: Record<string, any> };
  const dataTemplate = Template.fromStack(data).toJSON() as { Outputs: Record<string, any> };
  assert.deepEqual(Object.values(template.Resources).filter((r: any) => r.Type === "AWS::ApiGatewayV2::Route").map((r: any) => r.Properties.RouteKey).sort(), ["OPTIONS /semantic/related", "OPTIONS /semantic/search", "POST /semantic/related", "POST /semantic/search"]);
  assert.equal(Object.values(template.Resources).filter((r: any) => r.Type === "AWS::ApiGatewayV2::Integration")[0].Properties.PayloadFormatVersion, "2.0");
  assert.deepEqual(template.Outputs.SemanticUrl.Value, { "Fn::Join": ["", [{ "Fn::GetAtt": ["SemanticHttpApi", "ApiEndpoint"] }, "/semantic"]] }, "semanticUrl is the configured semantic base; clients append /search or /related");
  assert.deepEqual(Object.fromEntries(["SemanticAllowedOrigins", "SemanticSearchEnabled", "SemanticRelatedEnabled", "SemanticProcessingFingerprint"].map((key) => [key, template.Parameters[key].Default])), {
    SemanticAllowedOrigins: "", SemanticSearchEnabled: "false", SemanticRelatedEnabled: "false", SemanticProcessingFingerprint: "",
  });
  const permissions = Object.values(template.Resources).filter((r: any) => r.Type === "AWS::Lambda::Permission") as any[];
  assert.equal(permissions.length, 4);
  for (const suffix of ["POST/semantic/search", "POST/semantic/related", "OPTIONS/semantic/search", "OPTIONS/semantic/related"]) assert.equal(permissions.filter((permission) => JSON.stringify(permission.Properties.SourceArn).includes(suffix)).length, 1, `exact execute-api permission for ${suffix}`);
  const statements = Object.values(template.Resources).filter((r: any) => r.Type === "AWS::IAM::Policy").flatMap((r: any) => r.Properties.PolicyDocument.Statement);
  const allowed = statements.filter((s: any) => s.Effect === "Allow");
  assert.deepEqual(allowed.map((s: any) => s.Action).sort(), ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:SearchVectors", "s3:GetObject"]);
  const allow = (action: string) => allowed.find((statement: any) => statement.Action === action);
  const resource = (action: string) => allow(action).Resource;
  const imported = (token: any) => {
    const importToken = token["Fn::ImportValue"] ? token : token["Fn::Join"]?.[1]?.[0];
    const entries = Object.values(dataTemplate.Outputs).filter((output: any) => JSON.stringify(output.Export?.Name) === JSON.stringify(importToken?.["Fn::ImportValue"]));
    assert.equal(entries.length, 1, "each IAM resource is exactly one exported infrastructure token");
    return entries[0].Value;
  };
  assert.ok(imported(resource("dynamodb:SearchVectors")), "SearchVectors begins at the semantic table ARN export");
  assert.deepEqual(resource("dynamodb:SearchVectors")["Fn::Join"][1].slice(1), ["/index/semantic-embedding-v1"], "SearchVectors equals the native vector-index ARN token");
  assert.ok(imported(resource("dynamodb:Query")), "Query begins at the semantic table ARN export");
  assert.deepEqual(resource("dynamodb:Query")["Fn::Join"][1].slice(1), ["/index/semantic-by-sample"], "Query equals the source-GSI ARN token");
  const canonical = resource("dynamodb:GetItem");
  assert.equal(Array.isArray(canonical), true);
  assert.equal(canonical.length, 3, "GetItem receives exactly the three canonical table ARN tokens");
  assert.equal(new Set(canonical.map(imported).map((value: any) => JSON.stringify(value))).size, 3, "GetItem has one exact token per canonical Sample, Recording, and Clip table");
  assert.equal(JSON.stringify(canonical).includes("/index/"), false);
  const s3 = resource("s3:GetObject")["Fn::Join"];
  assert.equal(Array.isArray(s3), true);
  assert.ok(imported(s3[1][0]), "GetObject starts from the configured bucket ARN token");
  assert.deepEqual(s3[1].slice(1), ["/files/analysis/*"], "GetObject is restricted to the configured files/analysis prefix token");
  assert.equal(JSON.stringify(template).includes("dynamodb:Scan"), false);
  assert.equal(JSON.stringify(template).includes("dynamodb:PutItem"), false);
  assert.equal(JSON.stringify(template).includes("dynamodb:BatchGetItem"), false);
  const environment = Object.values(template.Resources).find((r: any) => r.Type === "AWS::Lambda::Function").Properties.Environment.Variables;
  assert.deepEqual(Object.keys(environment).filter((key) => key.startsWith("SEMANTIC_")).sort(), ["SEMANTIC_ALLOWED_ORIGINS", "SEMANTIC_PROCESSING_FINGERPRINT", "SEMANTIC_RELATED_ENABLED", "SEMANTIC_SEARCH_ENABLED", "SEMANTIC_TABLE", "SEMANTIC_VECTOR_INDEX"]);
});
