import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateBrowserReport, runBrowserFeasibility, type BrowserEvaluationReport, FIXED_PROMPTS, PINNED_MANIFEST, promptListHash, top20 } from "../scripts/semantic-eval.ts";
import { MINIMUM_REFERENCE_AUDIO_ENTRIES } from "../src/semantic/encoder-evaluation-contract.ts";

const unit = (index: number) => Array.from({ length: 512 }, (_, i) => i === index ? 1 : 0);
const audio = Array.from({ length: MINIMUM_REFERENCE_AUDIO_ENTRIES }, (_, index) => ({ semanticId: `audio-${String(index).padStart(2, "0")}`, vector512: unit(index) }));
const prompts = FIXED_PROMPTS.map((text, index) => ({ text, vector512: unit(index) }));

const report = (): BrowserEvaluationReport => ({
  schemaVersion: 1,
  status: "evaluated",
  pinnedManifest: PINNED_MANIFEST,
  referencePromptListHash: promptListHash(FIXED_PROMPTS),
  reference: { schemaVersion: 1, embeddingSpace: PINNED_MANIFEST.embeddingSpace, prompts, audio },
  desktop: measurement("desktop"),
  mobile: measurement("mobile"),
});

function measurement(device: string) {
  return { device, browser: "test browser", userAgent: "test agent", hardwareConcurrency: 4, cacheState: "warm" as const, cacheStorage: "available" as const, coldMs: [100], warmMs: Array(20).fill(100), prompts: prompts.map(({ text, vector512 }) => ({ prompt: text, browserVector512: vector512, cosine: 1, browserTop20: top20(vector512, audio), pythonTop20: top20(vector512, audio) })) };
}

describe("browser feasibility gate", () => {
  it("accepts evidence only when its manifest names the approved fp32 text asset", () => {
    assert.equal(PINNED_MANIFEST.dtype, "fp32");
    const invalid: any = report();
    invalid.pinnedManifest = { ...invalid.pinnedManifest, dtype: "q8" };
    assert.ok(evaluateBrowserReport(invalid).reasons.some((reason) => reason.includes("pinnedManifest does not match approved encoder")));
  });

  it("uses the M0 evaluation prompts in their fixed full-text order", () => {
    assert.deepEqual(FIXED_PROMPTS, ["the sound of a drum beat", "the sound of rain falling", "the sound of a bass guitar", "the sound of a person singing", "the sound of ambient music", "the sound of metal being struck"]);
  });
  it("does not turn absent browser measurements into a successful test", async () => {
    assert.deepEqual(await runBrowserFeasibility([]), { status: "not_evaluated", reasons: ["missing --report from a real Apricity browser run"] });
    const desktopOnly: any = report();
    delete desktopOnly.mobile;
    assert.equal(evaluateBrowserReport(desktopOnly).status, "not_evaluated");
  });

  it("evaluates the pinned report, every cosine, top-20 retention, and warm device p95", () => {
    assert.equal(evaluateBrowserReport(report()).status, "pass");
    const invalid = report();
    invalid.desktop.prompts[0].browserVector512 = unit(19);
    invalid.mobile.warmMs = [6000];
    assert.ok(evaluateBrowserReport(invalid).reasons.some((reason) => reason.includes("desktop the sound of a drum beat: cosine below")));
  });

  it("rejects malformed evidence instead of allowing a synthetic green gate", () => {
    const invalid: any = report();
    invalid.schemaVersion = 2;
    invalid.status = "pass";
    invalid.desktop.prompts = [invalid.desktop.prompts[0]];
    invalid.reference.audio[MINIMUM_REFERENCE_AUDIO_ENTRIES - 1].semanticId = invalid.reference.audio[0].semanticId;
    invalid.desktop.warmMs = [-1];
    invalid.mobile = undefined;
    const result = evaluateBrowserReport(invalid);
    assert.equal(result.status, "fail");
    assert.ok(result.reasons.some((reason) => reason.includes("schemaVersion")));
    assert.ok(result.reasons.some((reason) => reason.includes("exactly six")));
    assert.ok(result.reasons.some((reason) => reason.includes("unique")));
    assert.ok(result.reasons.some((reason) => reason.includes("nonnegative")));
    assert.ok(result.reasons.some((reason) => reason.includes("mobile")));
  });

  it("rejects a reference corpus below forty entries", () => {
    const invalid: any = report();
    invalid.reference.audio = invalid.reference.audio.slice(0, MINIMUM_REFERENCE_AUDIO_ENTRIES - 1);
    assert.ok(evaluateBrowserReport(invalid).reasons.some((reason) => reason.includes("at least 40")));
  });

  it("does not accept a warm-cache claim after CacheStorage was blocked", () => {
    const invalid: any = report();
    invalid.desktop.cacheStorage = "unavailable";
    invalid.desktop.cacheStorageError = "storage denied";
    assert.ok(evaluateBrowserReport(invalid).reasons.some((reason) => reason.includes("cannot claim warm cache evidence")));
  });
});
