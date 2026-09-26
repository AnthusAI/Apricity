// Checks a voice-line request and plans it: a queued voice Job, and the input for one render by the
// SpeechRenderer state machine (Auritus on AWS Batch). Pure, so it is tested without AWS.

/** Kokoro's American male narrator: the voice the example announcer uses. */
export const DEFAULT_VOICE = "kokoro:am_adam";
/** The renderer's own limit (auritus.render.MAX_TEXT_CHARACTERS). */
export const MAX_TEXT = 5000;
/** The only backend Apricity's renderer runs (its `allowedBackends`). */
const BACKENDS = ["kokoro"];
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface RequestArgs {
  name?: string | null;
  text?: string | null;
  voice?: string | null;
  speed?: number | null;
  seed?: number | null;
}

export class RequestError extends Error {}

export function planRequest(opts: { args: RequestArgs; requester: string; jobId: string; now: string }) {
  const { args, requester, jobId, now } = opts;
  const name = (args.name ?? "").trim();
  if (!NAME.test(name)) throw new RequestError("name: use 1–64 letters, digits, - or _ (it becomes voice/<name>.wav)");
  const text = args.text ?? "";
  if (!text.trim()) throw new RequestError("text: say something");
  if (text.length > MAX_TEXT) throw new RequestError(`text: at most ${MAX_TEXT} characters; split longer lines`);
  const voice = (args.voice ?? DEFAULT_VOICE).trim();
  const [backend, id] = voice.split(":");
  if (!BACKENDS.includes(backend) || !id) throw new RequestError(`voice: expected ${BACKENDS.map((b) => `${b}:<id>`).join(" or ")}, e.g. ${DEFAULT_VOICE}`);
  const speed = args.speed ?? null;
  if (speed !== null && !(speed >= 0.5 && speed <= 2)) throw new RequestError("speed: between 0.5 and 2");
  const seed = args.seed ?? null;

  const input = { name, text, voice, speed, seed, requester };
  return {
    path: `voice/${name}.wav`,
    job: { __typename: "Job", id: jobId, kind: "voice", state: "queued" as const, input: JSON.stringify(input), createdAt: now, updatedAt: now },
    render: { jobId, text, voice, speed, seed },
  };
}
