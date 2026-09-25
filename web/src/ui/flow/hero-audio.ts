// The hero's sound lives in the user's library, not in the app: the story asks for library keys
// (`hero/b-track.mp3`, ...) and gets them from wherever the library is served, through
// web/src/data/files.ts (`/files/<key>` from `apricity serve`, the bucket in the cloud). On a fresh
// clone nothing is there yet: the story then plays silent, and the sound button says why.
// Everything here is pure, so it can be tested without a browser.

import type { FlowAudio } from "./model";

/** What the sound button is doing: checking the library, ready, waiting for a click to resume sound
 *  that was on before a reload (`armed`), loading, playing, or out of luck. */
export type SoundState = "checking" | "ready" | "armed" | "loading" | "on" | "missing";

export interface SoundView {
  label: string;
  hint: string; // title and accessible name: the full explanation
  pressed: boolean;
  disabled: boolean;
}

export const MISSING_HINT = "Sound needs the audio library: run apricity migrate / fetch";

export function soundView(state: SoundState): SoundView {
  switch (state) {
    case "checking":
      return { label: "Turn on sound", hint: "Checking the audio library", pressed: false, disabled: true };
    case "ready":
      return { label: "Turn on sound", hint: "Turn on sound", pressed: false, disabled: false };
    case "armed":
      return { label: "Sound on — click to start", hint: "Sound was on: click or press a key anywhere to start it", pressed: true, disabled: false };
    case "loading":
      return { label: "Loading…", hint: "Loading the sound", pressed: false, disabled: true };
    case "on":
      return { label: "Sound on", hint: "Sound on", pressed: true, disabled: false };
    case "missing":
      return { label: "Sound needs the audio library", hint: MISSING_HINT, pressed: false, disabled: true };
  }
}

/** Every library key the story plays, sources first, each once. */
export function audioKeys(audio: FlowAudio): string[] {
  return [...new Set([...audio.sources, ...audio.tracks.map((t) => t.key)])];
}

/** A library-relative key: no leading slash, no scheme, no drive, no `.` or `..` segments, no backslashes. */
export function isLibraryKey(key: string): boolean {
  if (!key || key.startsWith("/") || key.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(key)) return false;
  return key.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** A probe or fetch answered with audio: 200, or 206 for a ranged request. */
export function isAudioStatus(status: number): boolean {
  return status === 200 || status === 206;
}

const SOUND_KEY = "apricity.heroSound";

/** Did the reader leave the sound on (it survives a reload)? Never throws: storage may be blocked. */
export function soundRemembered(store: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try {
    return store?.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}

/** Remember whether the sound is on, for the next visit or reload. */
export function rememberSound(on: boolean, store: Pick<Storage, "setItem" | "removeItem"> | undefined = globalThis.localStorage) {
  try {
    if (on) store?.setItem(SOUND_KEY, "on");
    else store?.removeItem(SOUND_KEY);
  } catch {
    // Private mode or blocked storage: the sound simply isn't remembered.
  }
}

/** The state after the library was probed: `status` is the HTTP status, or null when it could not be asked. */
export function stateAfterProbe(status: number | null): SoundState {
  return status !== null && isAudioStatus(status) ? "ready" : "missing";
}
