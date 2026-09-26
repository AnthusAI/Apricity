import { a, defineData, type ClientSchema } from "@aws-amplify/backend";

// The site is public: anyone reads, guests included (the identity pool's unauthenticated role). Signing in is for
// rating and making things.
const everyone = (allow: any) => [allow.guest().to(["read"]), allow.authenticated().to(["read"])];

// The library itself: curators write.
const catalog = (allow: any) => [...everyone(allow), allow.group("curators")];

// What people make (clips, markers, scores): public to read, the owner writes, curators can fix anything.
const made = (allow: any) => [...everyone(allow), allow.owner(), allow.group("curators")];

// Private to its owner (crates).
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
  // What a score is for. There is no other difference: a Beat is a score tagged beat, and so on.
  ScoreKind: a.enum(["song", "beat", "chords", "melody"]),
  // What can be rated.
  RatingTarget: a.enum(["sample", "clip", "score"]),

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
      // What it may be used for (a code in web/src/data/licenses.ts: "cc-by-sa-3.0", "public-domain"…), who a credit
      // names, and a curator's own credit line when the generated one won't do. Without `license`, the app reads it
      // from `rights`.
      license: a.string(),
      licenseUrl: a.url(),
      author: a.string(),
      attribution: a.string(),
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
    .authorization(made),

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
    .authorization(made),

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
      kind: a.ref("ScoreKind"),
      text: a.string().required(),
      lastErrors: a.string().array(),
      legacyPath: a.string(),
      owner: a.string(),
      refs: a.hasMany("ScoreRef", "scoreId"),
    })
    .secondaryIndexes((i) => [
      i("folder").sortKeys(["title"]).queryField("scoresByFolder"),
      i("kind").queryField("scoresByKind"),
    ])
    .authorization(made),

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
    .authorization(made),

  // One person's stars (0-5) for one item. Private: the id is `<targetType>#<targetId>#<owner>`, so a person has one
  // rating per item (the tally Lambda ignores any other id). Deleting it takes the rating back.
  Rating: a
    .model({
      id: a.id().required(),
      targetType: a.ref("RatingTarget").required(),
      targetId: a.id().required(),
      stars: a.integer().required(),
      ratedAt: a.datetime().required(),
      owner: a.string(),
    })
    .authorization((allow) => [allow.owner()]),

  // A comment on a sample, clip or score; `parentId` threads replies. Deleting one keeps it (blank, `deleted`) so its
  // replies keep their place. Anyone reads; the owner writes (the app asks for a handle first); curators moderate.
  Comment: a
    .model({
      id: a.id().required(),
      targetType: a.ref("RatingTarget").required(),
      targetId: a.id().required(),
      parentId: a.id(),
      body: a.string().required(),
      deleted: a.boolean(),
      owner: a.string(),
      createdAt: a.datetime(),
    })
    .secondaryIndexes((i) => [i("targetId").sortKeys(["createdAt"]).queryField("commentsByTarget")])
    .authorization((allow) => [...everyone(allow), allow.owner(), allow.group("curators")]),

  // The Activity page: one card per item (id `<targetType>#<targetId>`), moved to the top by anything new about it.
  // Written only by the activity Lambda from the tables' streams (amplify/functions/activity); `feed` is always "all",
  // so the index lists every card by its latest activity.
  Activity: a
    .model({
      id: a.id().required(),
      feed: a.string().required(),
      targetType: a.ref("RatingTarget").required(),
      targetId: a.id().required(),
      title: a.string(),
      kind: a.string(),
      owner: a.string(),
      samplePath: a.string(),
      lastAt: a.datetime().required(),
      lastWhat: a.string(),
      lastBy: a.string(),
      comments: a.integer(),
      ratings: a.integer(),
    })
    .secondaryIndexes((i) => [i("feed").sortKeys(["lastAt"]).queryField("activityByFeed")])
    .authorization(everyone),

  // One line of a card: made, changed, rated (with the stars), commented. Written only by the activity Lambda.
  ActivityEvent: a
    .model({
      id: a.id().required(),
      targetKey: a.string().required(),
      at: a.datetime().required(),
      what: a.string().required(),
      by: a.string(),
      stars: a.integer(),
      commentId: a.id(),
    })
    .secondaryIndexes((i) => [i("targetKey").sortKeys(["at"]).queryField("eventsByTarget")])
    .authorization(everyone),

  // A person's public name. The id is the handle itself (lowercase), so a create for a taken handle fails, even when
  // two people ask at once. The owner is set by AppSync, so the handle → person link can be trusted; changing a handle
  // is create-new-then-delete-old, and the newest one wins if both are briefly there. Curators can remove one.
  Handle: a
    .model({
      id: a.id().required(),
      owner: a.string(),
    })
    .secondaryIndexes((i) => [i("owner").queryField("handlesByOwner")])
    .authorization((allow) => [...everyone(allow), allow.owner().to(["create", "read", "delete"]), allow.group("curators")]),

  // The public side of ratings: per item, the count and star sum for one UTC day (`YYYY-MM-DD`) or for all time
  // (`all`). Written only by the tally Lambda from the Rating table's stream (amplify/functions/tally).
  Tally: a
    .model({
      id: a.id().required(),
      targetType: a.ref("RatingTarget").required(),
      targetId: a.id().required(),
      day: a.string().required(),
      count: a.integer().required(),
      sum: a.integer().required(),
    })
    .secondaryIndexes((i) => [i("targetType").sortKeys(["day"]).queryField("talliesByTypeAndDay")])
    .authorization(everyone),

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
