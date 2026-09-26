// The play button, one look everywhere: the top bar (a score, or a sample in Clips and Samples) and every breakdown.
// Starting can take a while the first time (the audio engine, then the sounds, then the mix), so while it gets ready
// the button turns into a ring that fills as the sounds arrive, with a line beside it saying what it is doing.
// It never looks idle while busy, and a click while busy does nothing.

import { el } from "./dom";

export type PlayState =
  | { kind: "idle" }
  | { kind: "playing" }
  /** Getting ready: `label` says what (short), `done`/`total` fill the ring when known. */
  | { kind: "loading"; label: string; done?: number; total?: number }
  /** Nothing to play here now; `why` is the tooltip. */
  | { kind: "unavailable"; why: string }
  /** It tried and failed: the reason shows beside it, and a click tries again. */
  | { kind: "error"; message: string };

const R = 15.5;
const C = 2 * Math.PI * R;
const SVG = `<svg viewBox="0 0 36 36" aria-hidden="true">
  <circle class="track" cx="18" cy="18" r="${R}" />
  <circle class="ring" cx="18" cy="18" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}" />
  <path class="icon-play" d="M14.5 11.5v13l10.5-6.5z" />
  <rect class="icon-stop" x="12.5" y="12.5" width="11" height="11" rx="1.5" />
</svg>`;

export class PlayButton {
  readonly root = el("div", { className: "playctl" });
  readonly button = el("button", { type: "button", className: "play", innerHTML: SVG });
  private status = el("span", { className: "play-status", role: "status" });
  private ring = this.button.querySelector<SVGCircleElement>(".ring")!;
  state: PlayState = { kind: "idle" };

  /** `what` names the thing played, for screen readers ("score", "sample", "breakdown"); `key` is its shortcut. */
  constructor(
    private what: string,
    onClick: () => void,
    private key = "",
  ) {
    this.root.append(this.status, this.button);
    this.button.addEventListener("click", () => {
      if (this.state.kind === "loading" || this.state.kind === "unavailable") return;
      onClick();
    });
    this.set({ kind: "idle" });
  }

  set(s: PlayState) {
    this.state = s;
    const b = this.button;
    b.dataset.state = s.kind;
    b.setAttribute("aria-disabled", String(s.kind === "loading" || s.kind === "unavailable"));
    b.setAttribute("aria-busy", String(s.kind === "loading"));
    const known = s.kind === "loading" && s.total ? Math.min(1, (s.done ?? 0) / s.total) : null;
    b.classList.toggle("spin", s.kind === "loading" && known === null);
    this.ring.style.strokeDashoffset = String(s.kind === "loading" ? C * (1 - (known ?? 0.25)) : C);
    const label =
      s.kind === "loading" ? `${s.label}${s.total ? ` ${Math.min(s.done ?? 0, s.total)} of ${s.total}` : ""}…` : s.kind === "error" ? `Couldn't play: ${s.message}` : "";
    this.status.textContent = label;
    this.status.hidden = !label;
    this.status.classList.toggle("bad", s.kind === "error");
    b.ariaLabel = s.kind === "playing" ? `Stop the ${this.what}` : s.kind === "loading" || s.kind === "error" ? `${label} (${this.what})` : `Play the ${this.what}`;
    const key = this.key ? ` (${this.key})` : "";
    b.title = s.kind === "unavailable" ? s.why : s.kind === "loading" ? label : s.kind === "error" ? `${label}. Click to try again.` : s.kind === "playing" ? `Stop${key}` : `Play${key}`;
  }
}
