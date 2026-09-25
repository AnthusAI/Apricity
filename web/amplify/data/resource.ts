import { a, defineData, type ClientSchema } from "@aws-amplify/backend";

const catalog = (allow: any) => [
  allow.group("members").to(["read"]),
  allow.group("curators"),
];

const personal = (allow: any) => [allow.owner(), allow.group("members").to(["read"])];

const schema = a.schema({
  FileRef: a.customType({
    key: a.string().required(),
    sha256: a.string().required(),
    size: a.integer(),
    contentType: a.string(),
  }),
  Proposer: a.customType({
    by: a.string().required(),
    score: a.float().required(),
    why: a.string().required(),
    evidence: a.json(),
    at: a.datetime().required(),
  }),
  CandidateContext: a.customType({
    seconds: a.float(),
    bpm: a.float(),
    beats: a.float(),
    key: a.string(),
    stem: a.string(),
  }),
  ClipSource: a.enum(["user", "ml", "curated"]),
  Kind: a.enum(["loop", "break", "hit", "phrase", "section", "chop", "other"]),
  VerdictValue: a.enum(["keep", "skip", "later"]),

  Recording: a
    .model({
      id: a.id().required(),
      title: a.string().required(),
      collection: a.string().required(),
      performer: a.string(),
      composed: a.integer(),
      recorded: a.string(),
      credit: a.string(),
      rights: a.string(),
      sourcePage: a.url(),
      url: a.url(),
      documents: a.ref("FileRef").array(),
      samples: a.hasMany("Sample", "recordingId"),
    })
    .secondaryIndexes((i) => [
      i("collection")
        .sortKeys(["title"])
        .queryField("recordingsByCollection"),
    ])
    .authorization(catalog),

  Sample: a
    .model({
      id: a.id().required(),
      recordingId: a.id().required(),
      recording: a.belongsTo("Recording", "recordingId"),
      path: a.string().required(),
      aliases: a.string().array(),
      collection: a.string().required(),
      title: a.string().required(),
      role: a.enum(["source", "stem", "excerpt", "upload"]),
      stem: a.string(),
      stemModel: a.string(),
      parentSampleId: a.id(),
      excerptStart: a.float(),
      audio: a.ref("FileRef").required(),
      analysis: a.ref("FileRef"),
      analysisVersion: a.integer(),
      analyzedAt: a.datetime(),
      status: a.enum(["pending", "analyzing", "ready", "failed"]),
      duration: a.float(),
      sampleRate: a.integer(),
      channels: a.integer(),
      bpm: a.float(),
      bpmStability: a.float(),
      meter: a.integer(),
      key: a.string(),
      camelot: a.string(),
      keysOverTime: a.string().array(),
      tuningCents: a.float(),
      noteCount: a.integer(),
      tags: a.string().array(),
      nameCounters: a.json(),
      clips: a.hasMany("Clip", "sampleId"),
      markers: a.hasMany("Marker", "sampleId"),
      candidates: a.hasMany("Candidate", "sampleId"),
    })
    .secondaryIndexes((i) => [
      i("recordingId")
        .sortKeys(["path"])
        .queryField("samplesByRecording"),
      i("collection").sortKeys(["path"]).queryField("samplesByCollection"),
      i("path").queryField("samplesByPath"),
      i("parentSampleId").queryField("samplesByParent"),
    ])
    .authorization(catalog),

  Clip: a
    .model({
      id: a.id().required(),
      sampleId: a.id().required(),
      sample: a.belongsTo("Sample", "sampleId"),
      name: a.string().required(),
      start: a.float().required(),
      end: a.float().required(),
      source: a.ref("ClipSource").required(),
      kind: a.ref("Kind"),
      tags: a.string().array(),
      evidence: a.json(),
      rank: a.integer(),
      candidateId: a.id(),
      retired: a.boolean(),
      owner: a.string(),
    })
    .secondaryIndexes((i) => [
      i("sampleId").sortKeys(["start"]).queryField("clipsBySample"),
      i("sampleId").sortKeys(["name"]).queryField("clipsBySampleAndName"),
      i("candidateId").queryField("clipsByCandidate"),
    ])
    .authorization((allow) => [...personal(allow), allow.group("curators")]),

  Marker: a
    .model({
      id: a.id().required(),
      sampleId: a.id().required(),
      sample: a.belongsTo("Sample", "sampleId"),
      name: a.string().required(),
      seconds: a.float().required(),
      source: a.ref("ClipSource"),
      note: a.string(),
      owner: a.string(),
    })
    .secondaryIndexes((i) => [
      i("sampleId").sortKeys(["seconds"]).queryField("markersBySample"),
    ])
    .authorization((allow) => [...personal(allow), allow.group("curators")]),

  Candidate: a
    .model({
      id: a.id().required(),
      sampleId: a.id().required(),
      sample: a.belongsTo("Sample", "sampleId"),
      recordingId: a.id().required(),
      start: a.float().required(),
      end: a.float().required(),
      kind: a.ref("Kind").required(),
      name: a.string(),
      context: a.ref("CandidateContext"),
      proposers: a.ref("Proposer").array().required(),
      baseScore: a.float().required(),
      legacyId: a.string(),
      verdicts: a.hasMany("Verdict", "candidateId"),
    })
    .secondaryIndexes((i) => [
      i("kind").sortKeys(["baseScore"]).queryField("candidatesByKind"),
      i("recordingId")
        .sortKeys(["baseScore"])
        .queryField("candidatesByRecording"),
      i("sampleId").sortKeys(["start"]).queryField("candidatesBySample"),
    ])
    .authorization(catalog),

  Verdict: a
    .model({
      candidateId: a.id().required(),
      judge: a.string().required(),
      candidate: a.belongsTo("Candidate", "candidateId"),
      verdict: a.ref("VerdictValue").required(),
      stars: a.integer(),
      tags: a.string().array(),
      name: a.string(),
      judgedAt: a.datetime().required(),
      by: a.string(),
    })
    .identifier(["candidateId", "judge"])
    .secondaryIndexes((i) => [
      i("judge").sortKeys(["judgedAt"]).queryField("verdictsByJudge"),
    ])
    .authorization((allow) => [
      allow.ownerDefinedIn("judge").identityClaim("sub"),
      allow.group("admins").to(["read"]),
    ]),

  Crate: a
    .model({
      id: a.id().required(),
      name: a.string().required(),
      note: a.string(),
      owner: a.string(),
      items: a.hasMany("CrateItem", "crateId"),
    })
    .secondaryIndexes((i) => [
      i("owner").sortKeys(["name"]).queryField("cratesByOwner"),
    ])
    .authorization(personal),

  CrateItem: a
    .model({
      id: a.id().required(),
      crateId: a.id().required(),
      crate: a.belongsTo("Crate", "crateId"),
      position: a.string().required(),
      candidateId: a.id(),
      clipId: a.id(),
      sampleId: a.id(),
      note: a.string(),
      owner: a.string(),
    })
    .secondaryIndexes((i) => [
      i("crateId").sortKeys(["position"]).queryField("crateItemsByCrate"),
      i("candidateId").queryField("crateItemsByCandidate"),
    ])
    .authorization(personal),

  Score: a
    .model({
      id: a.id().required(),
      title: a.string().required(),
      folder: a.string().required(),
      format: a.enum(["apr", "yaml"]),
      text: a.string().required(),
      lastErrors: a.string().array(),
      legacyPath: a.string(),
      owner: a.string(),
      refs: a.hasMany("ScoreRef", "scoreId"),
    })
    .secondaryIndexes((i) => [
      i("folder").sortKeys(["title"]).queryField("scoresByFolder"),
    ])
    .authorization(personal),

  ScoreRef: a
    .model({
      id: a.id().required(),
      scoreId: a.id().required(),
      score: a.belongsTo("Score", "scoreId"),
      clipAlias: a.string().required(),
      sampleId: a.id(),
      samplePath: a.string(),
      clipName: a.string(),
      clipId: a.id(),
      start: a.float(),
      end: a.float(),
      owner: a.string(),
    })
    .secondaryIndexes((i) => [
      i("scoreId").queryField("refsByScore"),
      i("sampleId").sortKeys(["scoreId"]).queryField("refsBySample"),
      i("clipId").queryField("refsByClip"),
    ])
    .authorization(personal),

  Job: a
    .model({
      id: a.id().required(),
      kind: a.string().required(),
      sampleId: a.id(),
      state: a.enum(["queued", "running", "done", "failed"]),
      error: a.string(),
    })
    .secondaryIndexes((i) => [i("state").queryField("jobsByState")])
    .authorization(catalog),
});

export { schema };
export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
    apiKeyAuthorizationMode: {
      expiresInDays: 365,
    },
  },
});
