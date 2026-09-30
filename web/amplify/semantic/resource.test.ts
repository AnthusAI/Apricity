import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  SEMANTIC_VECTOR_INDEX_NAME,
  createSemanticAudioResources,
  semanticCanonicalReadPolicy,
  semanticPublisherPolicy,
  semanticSearchVectorsPolicy,
} from "./resource";

const synth = () => {
  const app = new App();
  const stack = new Stack(app, "SemanticAudio", {
    env: { account: "000000000000", region: "us-east-1" },
  });
  const resources = createSemanticAudioResources(stack);
  return { resources, template: Template.fromStack(stack).toJSON() };
};

describe("semantic audio DynamoDB resource", () => {
  it("synthesizes the dedicated retained on-demand table and its native vector index", () => {
    const { template } = synth();
    const tables = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === "AWS::DynamoDB::Table",
    ) as Array<{ DeletionPolicy?: string; UpdateReplacePolicy?: string; Properties: Record<string, unknown> }>;

    assert.equal(tables.length, 1);
    const table = tables[0];
    assert.equal(table.DeletionPolicy, "Retain");
    assert.equal(table.UpdateReplacePolicy, "Retain");
    assert.deepEqual(table.Properties.BillingMode, "PAY_PER_REQUEST");
    assert.deepEqual(table.Properties.DeletionProtectionEnabled, true);
    assert.deepEqual(table.Properties.KeySchema, [
      { AttributeName: "embeddingSpace", KeyType: "HASH" },
      { AttributeName: "semanticId", KeyType: "RANGE" },
    ]);
    assert.deepEqual(table.Properties.AttributeDefinitions, [
      { AttributeName: "embeddingSpace", AttributeType: "S" },
      { AttributeName: "semanticId", AttributeType: "S" },
      { AttributeName: "kind", AttributeType: "S" },
      { AttributeName: "sampleId", AttributeType: "S" },
    ]);
    assert.equal(table.Properties.StreamSpecification, undefined);

    assert.deepEqual(table.Properties.VectorIndexes, [
      {
        IndexName: SEMANTIC_VECTOR_INDEX_NAME,
        Dimensions: 512,
        DistanceFunction: "DOT_PRODUCT",
        VectorAttribute: { AttributeName: "vector" },
        SearchSchema: [
          { AttributeName: "embeddingSpace", SearchSchemaElementType: "HASH" },
          { AttributeName: "kind", SearchSchemaElementType: "INLINE_FILTER" },
          { AttributeName: "sampleId", SearchSchemaElementType: "INLINE_FILTER" },
        ],
        Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["identity", "revision"] },
      },
    ]);
  });

  it("exports deterministic identifiers and only produces scoped server and publisher policy statements", () => {
    const { resources } = synth();
    const search = semanticSearchVectorsPolicy(resources.vectorIndexArn);
    const reads = semanticCanonicalReadPolicy(resources.tableArn);
    const publisher = semanticPublisherPolicy(resources.tableArn);

    assert.equal(resources.indexName, SEMANTIC_VECTOR_INDEX_NAME);
    assert.deepEqual(search, {
      actions: ["dynamodb:SearchVectors"],
      resources: [resources.vectorIndexArn],
    });
    assert.deepEqual(reads, {
      actions: ["dynamodb:BatchGetItem", "dynamodb:GetItem"],
      resources: [resources.tableArn],
    });
    assert.deepEqual(publisher, {
      actions: ["dynamodb:DeleteItem", "dynamodb:PutItem", "dynamodb:Query"],
      resources: [resources.tableArn],
    });
    assert.equal(search.actions.includes("dynamodb:Scan"), false);
    assert.equal(reads.actions.includes("dynamodb:SearchVectors"), false);
    assert.equal(reads.actions.includes("dynamodb:Query"), false);
    assert.equal(publisher.actions.includes("dynamodb:Scan"), false);
  });

  it("does not create guest permissions, stream consumers, or any attached IAM policy", () => {
    const { template } = synth();
    const types = Object.values(template.Resources).map((resource: any) => resource.Type);
    assert.equal(types.includes("AWS::IAM::Policy"), false);
    assert.equal(types.includes("AWS::Lambda::EventSourceMapping"), false);
  });
});
