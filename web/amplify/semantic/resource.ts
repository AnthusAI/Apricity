import { CfnTable } from "aws-cdk-lib/aws-dynamodb";
import { Fn, RemovalPolicy } from "aws-cdk-lib";
import { createHash } from "node:crypto";
import type { Construct } from "constructs";

/**
 * AWS::DynamoDB::Table VectorIndex is not yet represented by the installed CDK
 * CfnTable type. Keep this name shared by the table, policy helpers, and later
 * retrieval integration so SearchVectors is always scoped to one index.
 */
export const SEMANTIC_VECTOR_INDEX_NAME = "semantic-embedding-v1";
export const SEMANTIC_BY_SAMPLE_INDEX_NAME = "semantic-by-sample";

export type DynamoDbPolicy = Readonly<{
  actions: readonly string[];
  resources: readonly string[];
}>;

export type SemanticAudioResources = Readonly<{
  table: CfnTable;
  tableName: string;
  tableArn: string;
  indexName: typeof SEMANTIC_VECTOR_INDEX_NAME;
  vectorIndexArn: string;
  sampleIndexName: typeof SEMANTIC_BY_SAMPLE_INDEX_NAME;
  sampleIndexArn: string;
}>;

/** Stable cross-runtime source partition: SHA256(UTF-8 JSON.stringify([space, sampleId])). */
export const semanticSamplePartition = (embeddingSpace: string, sampleId: string): string =>
  createHash("sha256").update(JSON.stringify([embeddingSpace, sampleId]), "utf8").digest("hex");

/** Creates the isolated store for canonical semantic records; it intentionally creates no stream or grants. */
export const createSemanticAudioResources = (scope: Construct): SemanticAudioResources => {
  const table = new CfnTable(scope, "SemanticRecords", {
    billingMode: "PAY_PER_REQUEST",
    deletionProtectionEnabled: true,
    attributeDefinitions: [
      { attributeName: "embeddingSpace", attributeType: "S" },
      { attributeName: "semanticId", attributeType: "S" },
      // CloudFormation requires all SearchSchema attributes to appear here.
      { attributeName: "kind", attributeType: "S" },
      { attributeName: "sampleId", attributeType: "S" },
      { attributeName: "samplePartition", attributeType: "S" },
    ],
    globalSecondaryIndexes: [
      {
        indexName: SEMANTIC_BY_SAMPLE_INDEX_NAME,
        keySchema: [
          { attributeName: "samplePartition", keyType: "HASH" },
          { attributeName: "semanticId", keyType: "RANGE" },
        ],
        projection: { projectionType: "ALL" },
      },
    ],
    keySchema: [
      { attributeName: "embeddingSpace", keyType: "HASH" },
      { attributeName: "semanticId", keyType: "RANGE" },
    ],
  });
  table.applyRemovalPolicy(RemovalPolicy.RETAIN, { applyToUpdateReplacePolicy: true });

  // Verified against AWS::DynamoDB::Table VectorIndex. CDK v2.270.0 exposes no typed VectorIndexes property.
  table.addPropertyOverride("VectorIndexes", [
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
      // Search returns only the immutable identity and revision needed to hydrate a hit. The retrieval service must
      // BatchGet/Get the *current* canonical Sample, Recording, Clip, and analysis entities, then reject a hit unless
      // visibility, audio hash, boundaries, embedding space, processing fingerprint, and revision are still current.
      // Display and playback metadata are therefore hydrated from canonical entities, never this index; neither those
      // fields nor the vector are projected.
      Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["identity", "revision"] },
    },
  ]);

  const tableArn = table.attrArn;
  return {
    table,
    tableName: table.ref,
    tableArn,
    indexName: SEMANTIC_VECTOR_INDEX_NAME,
    vectorIndexArn: Fn.join("", [tableArn, "/index/", SEMANTIC_VECTOR_INDEX_NAME]),
    sampleIndexName: SEMANTIC_BY_SAMPLE_INDEX_NAME,
    sampleIndexArn: Fn.join("", [tableArn, "/index/", SEMANTIC_BY_SAMPLE_INDEX_NAME]),
  };
};

/** The retrieval Lambda needs only the native vector operation on this one index. */
export const semanticSearchVectorsPolicy = (vectorIndexArn: string): DynamoDbPolicy => ({
  actions: ["dynamodb:SearchVectors"],
  resources: [vectorIndexArn],
});

/**
 * Canonical hydration is deliberately separate from vector search. Callers may read only supplied canonical-table
 * keys and must reject missing, hidden, retired, or freshness-mismatched entities before exposing a result.
 */
export const semanticCanonicalReadPolicy = (tableArn: string): DynamoDbPolicy => ({
  actions: ["dynamodb:BatchGetItem", "dynamodb:GetItem"],
  resources: [tableArn],
});

/** Source resolution is restricted to the exact sample lookup index, never the base table. */
export const semanticSourceLookupPolicy = (sampleIndexArn: string): DynamoDbPolicy => ({
  actions: ["dynamodb:Query"],
  resources: [sampleIndexArn],
});

/** Ground publication can reconcile a declared partition and upsert/delete its own semantic rows, never scan. */
export const semanticPublisherPolicy = (tableArn: string, sampleIndexArn: string): readonly DynamoDbPolicy[] => [
  { actions: ["dynamodb:DeleteItem", "dynamodb:PutItem"], resources: [tableArn] },
  semanticSourceLookupPolicy(sampleIndexArn),
];
