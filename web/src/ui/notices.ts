// One place where failures are shown: a small stack of notices at the bottom of the page. Errors stay until you
// dismiss them; news fades after a few seconds; the same message again shows once, with a count. Anything that goes
// wrong outside the play button (a list that wouldn't load, a waveform, a rating) reports here instead of failing
// silently.

import { SignedOut } from "../data/catalog";

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface Notice {
  message: string;
  kind: "error" | "info";
  count: number;
  action?: NoticeAction;
}

const INFO_MS = 5000;

/** The notices themselves, apart from the page (tested in test/notices.test.ts). */
export class Notices {
  readonly list: Notice[] = [];
  private listeners = new Set<() => void>();

  onChange(f: () => void) {
    this.listeners.add(f);
  }

  private changed() {
    for (const f of this.listeners) f();
  }

  /** Show a notice; the same message again adds to its count instead of stacking. */
  add(message: string, kind: Notice["kind"] = "error", action?: NoticeAction): Notice {
    const same = this.list.find((n) => n.message === message && n.kind === kind);
    if (same) {
      same.count++;
      this.changed();
      return same;
    }
    const n: Notice = { message, kind, count: 1, ...(action ? { action } : {}) };
    this.list.push(n);
    this.changed();
    return n;
  }

  dismiss(n: Notice) {
    const i = this.list.indexOf(n);
    if (i >= 0) this.list.splice(i, 1), this.changed();
  }
}

export const notices = new Notices();

/** Show a notice (and, for news, fade it after a few seconds). */
export function notify(message: string, opts: { kind?: Notice["kind"]; action?: NoticeAction } = {}) {
  const n = notices.add(message, opts.kind ?? "error", opts.action);
  if (n.kind === "info") setTimeout(() => notices.dismiss(n), INFO_MS);
}

/** "Couldn't <what>: <why>" as an error notice. Being signed out isn't an error here: the views already say so. */
export function reportError(what: string, e: unknown): void {
  if (e instanceof SignedOut) return;
  const why = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  notify(`Couldn't ${what}${why ? `: ${why}` : ""}`);
}

/** Draw the notices into `host` (once, at start-up). */
export function mountNotices(host: HTMLElement) {
  host.className = "notices";
  host.setAttribute("aria-live", "polite");
  const draw = () => {
    host.replaceChildren(
      ...notices.list.map((n) => {
        const box = document.createElement("div");
        box.className = `notice ${n.kind}`;
        box.setAttribute("role", n.kind === "error" ? "alert" : "status");
        const text = document.createElement("span");
        text.textContent = n.count > 1 ? `${n.message} (×${n.count})` : n.message;
        box.append(text);
        if (n.action) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "notice-action";
          b.textContent = n.action.label;
          b.addEventListener("click", () => (notices.dismiss(n), n.action!.run()));
          box.append(b);
        }
        const x = document.createElement("button");
        x.type = "button";
        x.className = "notice-close";
        x.ariaLabel = "Dismiss";
        x.textContent = "×";
        x.addEventListener("click", () => notices.dismiss(n));
        box.append(x);
        return box;
      }),
    );
  };
  notices.onChange(draw);
  draw();
}
