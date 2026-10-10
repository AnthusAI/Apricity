/** Shared, environment-neutral browser feasibility evaluation contract. */
export const EVALUATION_PROMPTS = [
  "the sound of a drum beat",
  "the sound of rain falling",
  "the sound of a bass guitar",
  "the sound of a person singing",
  "the sound of ambient music",
  "the sound of metal being struck",
] as const;

export const MINIMUM_REFERENCE_AUDIO_ENTRIES = 40;

export function promptListHash(prompts: readonly string[]): string {
  let hash = 2166136261;
  for (const text of prompts.join("\u001f")) {
    hash ^= text.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function isVector512(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === 512
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

export function isNormalizedVector512(value: unknown): value is number[] {
  return isVector512(value) && (() => {
    const norm = Math.hypot(...value);
    return norm > 1e-9 && Math.abs(norm - 1) <= 1e-4;
  })();
}
