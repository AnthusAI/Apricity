import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  SEMANTIC_BY_SAMPLE_INDEX_NAME,
  SEMANTIC_VECTOR_INDEX_NAME,
  createSemanticAudioResources,
  semanticCanonicalReadPolicy,
  semanticPublisherPolicy,
  semanticSamplePartition,
  semanticSearchVectorsPolicy,
  semanticSourceLookupPolicy,
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
  it("synthesizes a retained table with a sample-scoped source GSI while keeping the native index narrow", () => {
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
      { AttributeName: "samplePartition", AttributeType: "S" },
    ]);
    assert.equal(table.Properties.StreamSpecification, undefined);
    assert.deepEqual(table.Properties.GlobalSecondaryIndexes, [
      {
        IndexName: SEMANTIC_BY_SAMPLE_INDEX_NAME,
        KeySchema: [
          { AttributeName: "samplePartition", KeyType: "HASH" },
          { AttributeName: "semanticId", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ]);

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
    const source = semanticSourceLookupPolicy(resources.sampleIndexArn);
    const publisher = semanticPublisherPolicy(resources.tableArn, resources.sampleIndexArn);

    assert.equal(resources.indexName, SEMANTIC_VECTOR_INDEX_NAME);
    assert.equal(resources.sampleIndexName, SEMANTIC_BY_SAMPLE_INDEX_NAME);
    assert.deepEqual(search, {
      actions: ["dynamodb:SearchVectors"],
      resources: [resources.vectorIndexArn],
    });
    assert.deepEqual(reads, {
      actions: ["dynamodb:BatchGetItem", "dynamodb:GetItem"],
      resources: [resources.tableArn],
    });
    assert.deepEqual(source, { actions: ["dynamodb:Query"], resources: [resources.sampleIndexArn] });
    assert.deepEqual(publisher, [
      { actions: ["dynamodb:DeleteItem", "dynamodb:PutItem"], resources: [resources.tableArn] },
      { actions: ["dynamodb:Query"], resources: [resources.sampleIndexArn] },
    ]);
    assert.equal(search.actions.includes("dynamodb:Scan"), false);
    assert.equal(reads.actions.includes("dynamodb:SearchVectors"), false);
    assert.equal(reads.actions.includes("dynamodb:Query"), false);
    assert.equal(source.actions.includes("dynamodb:Scan"), false);
    assert.equal(publisher.flatMap((statement) => statement.actions).includes("dynamodb:Scan"), false);
  });

  it("hashes the compact UTF-8 JSON source scope identically across publisher implementations", () => {
    assert.equal(
      semanticSamplePartition("cläp/é", "smp_音楽"),
      "8ed4e143b7999b4a5595abb975057a51f01f511be1ad9d02f4c7067aad823740",
    );
  });

  it("does not create guest permissions, stream consumers, or any attached IAM policy", () => {
    const { template } = synth();
    const types = Object.values(template.Resources).map((resource: any) => resource.Type);
    assert.equal(types.includes("AWS::IAM::Policy"), false);
    assert.equal(types.includes("AWS::Lambda::EventSourceMapping"), false);
  });
});
