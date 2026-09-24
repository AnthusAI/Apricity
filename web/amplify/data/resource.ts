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
  SliceSource: a.enum(["user", "ml", "curated"]),
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
      clips: a.hasMany("Clip", "recordingId"),
    })
    .secondaryIndexes((i) => [
      i("collection")
        .sortKeys(["title"])
        .queryField("recordingsByCollection"),
    ])
    .authorization(catalog),

  Clip: a
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
      parentClipId: a.id(),
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
      slices: a.hasMany("Slice", "clipId"),
      markers: a.hasMany("Marker", "clipId"),
      candidates: a.hasMany("Candidate", "clipId"),
    })
    .secondaryIndexes((i) => [
      i("recordingId")
        .sortKeys(["path"])
        .queryField("clipsByRecording"),
      i("collection").sortKeys(["path"]).queryField("clipsByCollection"),
      i("path").queryField("clipsByPath"),
      i("parentClipId").queryField("clipsByParent"),
    ])
    .authorization(catalog),

  Slice: a
    .model({
      id: a.id().required(),
      clipId: a.id().required(),
      clip: a.belongsTo("Clip", "clipId"),
      name: a.string().required(),
      start: a.float().required(),
      end: a.float().required(),
      source: a.ref("SliceSource").required(),
      kind: a.ref("Kind"),
      tags: a.string().array(),
      evidence: a.json(),
      rank: a.integer(),
      candidateId: a.id(),
      retired: a.boolean(),
      owner: a.string(),
    })
    .secondaryIndexes((i) => [
      i("clipId").sortKeys(["start"]).queryField("slicesByClip"),
      i("clipId").sortKeys(["name"]).queryField("slicesByClipAndName"),
      i("candidateId").queryField("slicesByCandidate"),
    ])
    .authorization((allow) => [...personal(allow), allow.group("curators")]),

  Marker: a
    .model({
      id: a.id().required(),
      clipId: a.id().required(),
      clip: a.belongsTo("Clip", "clipId"),
      name: a.string().required(),
      seconds: a.float().required(),
      source: a.ref("SliceSource"),
      note: a.string(),
      owner: a.string(),
    })
    .secondaryIndexes((i) => [
      i("clipId").sortKeys(["seconds"]).queryField("markersByClip"),
    ])
    .authorization((allow) => [...personal(allow), allow.group("curators")]),

  Candidate: a
    .model({
      id: a.id().required(),
      clipId: a.id().required(),
      clip: a.belongsTo("Clip", "clipId"),
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
      i("clipId").sortKeys(["start"]).queryField("candidatesByClip"),
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
      sliceId: a.id(),
      clipId: a.id(),
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
      clipId: a.id(),
      clipPath: a.string(),
      sliceName: a.string(),
      sliceId: a.id(),
      start: a.float(),
      end: a.float(),
      owner: a.string(),
    })
    .secondaryIndexes((i) => [
      i("scoreId").queryField("refsByScore"),
      i("clipId").sortKeys(["scoreId"]).queryField("refsByClip"),
      i("sliceId").queryField("refsBySlice"),
    ])
    .authorization(personal),

  Job: a
    .model({
      id: a.id().required(),
      kind: a.string().required(),
      clipId: a.id(),
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
