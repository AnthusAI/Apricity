// Header account control (cloud mode only): Sign in / email + Sign out, and the dialog behind them.
// Sign in, create account + emailed code, Google when the outputs configure it, and (admins) the library import.
// Passwords live only in input fields and one closure variable while a code is pending; they are never stored or logged.

import * as auth from "../data/auth";
import type { Account, AuthStep } from "../data/auth";
import { el } from "./dom";
import { displayName, initial } from "./account-state";
import type { ImportProgress, ImportSummary } from "../data/import-library";
import { HANDLE_MAX, handleProblem, normalizeHandle, suggestHandle } from "../data/handles";

export interface AccountDeps {
  cloud: () => boolean;
  currentAccount: () => Promise<Account | null>;
  googleAvailable: () => boolean;
  emailLoginAvailable: () => boolean;
  signInWithPassword: (email: string, password: string) => Promise<AuthStep>;
  signUpWithPassword: (email: string, password: string) => Promise<AuthStep>;
  confirmSignUpCode: (email: string, code: string) => Promise<void>;
  resendConfirmationCode: (email: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOutAccount: () => Promise<void>;
  importLibrary: (o: { onProgress: (p: ImportProgress) => void; signal: AbortSignal }) => Promise<ImportSummary>;
  announce: () => void;
  /** The person's public handle, if they have one. */
  myHandle: (owners: string[]) => Promise<string | undefined>;
  handleFree: (handle: string) => Promise<boolean>;
  claimHandle: (handle: string, owners: string[]) => Promise<{ ok: true; handle: string } | { ok: false; why: string }>;
}

/** The owner values AppSync may have stamped for this account (see `me()`). */
const ownersOf = (a: Account) => [a.username, `${a.sub}::${a.username}`];

/** The real thing: the data-layer wrappers, and the import module loaded only when an admin asks for it. */
export function realDeps(isCloud: () => boolean): AccountDeps {
  return {
    cloud: isCloud,
    currentAccount: auth.currentAccount,
    googleAvailable: auth.googleAvailable,
    emailLoginAvailable: auth.emailLoginAvailable,
    signInWithPassword: auth.signInWithPassword,
    signUpWithPassword: auth.signUpWithPassword,
    confirmSignUpCode: auth.confirmSignUpCode,
    resendConfirmationCode: auth.resendConfirmationCode,
    signInWithGoogle: auth.signInWithGoogle,
    signOutAccount: auth.signOutAccount,
    importLibrary: async (o) => (await import("../data/import-library")).importLibraryFromBucket(o),
    announce: () => document.dispatchEvent(new CustomEvent("apricity:auth-changed")),
    myHandle: async (owners) => (await (await import("../data/handles")).handles()).mine(owners),
    handleFree: async (h) => (await import("../data/handles")).handleFree(h),
    claimHandle: async (h, owners) => (await import("../data/handles")).claimHandle(h, owners),
  };
}

type View = "signin" | "signup" | "confirm" | "account" | "import" | "handle";

export class AccountControl {
  private dlg = el("dialog", { className: "acct-dialog" });
  private account: Account | null = null;
  private handle: string | undefined;
  private askedForHandle = false; // once per page load; it asks again next time until a handle is chosen
  private view: View = "signin";
  private email = "";
  private pendingPassword = ""; // only between "create account" and the code, so we can sign in afterwards
  private abort: AbortController | null = null;

  constructor(private host: HTMLElement, private deps: AccountDeps) {
    if (!deps.cloud()) {
      // Local mode (`apricity serve`): no accounts, but the same place says who you are: the library's one person.
      host.hidden = false;
      host.replaceChildren(
        el(
          "div",
          { className: "acct-pill local", title: "You're working on your own library on this computer: no account needed, and everything is yours to change." },
          el("span", { className: "acct-avatar", ariaHidden: "true" }, "L"),
          el("span", { className: "acct-email" }, "Local library"),
        ),
      );
      return;
    }
    host.hidden = false;
    document.body.append(this.dlg);
    this.dlg.setAttribute("aria-labelledby", "acct-title");
    this.dlg.addEventListener("close", () => {
      this.abort?.abort();
      this.pendingPassword = "";
    });
    this.dlg.addEventListener("click", (e) => {
      if (e.target === this.dlg) this.dlg.close(); // click on the backdrop
    });
    document.addEventListener("apricity:auth-changed", () => void this.refresh());
    // Something that needs the library asked the reader to sign in (e.g. a breakdown's "Open in Score").
    document.addEventListener("apricity:sign-in", () => void (this.account ? null : this.open("signin")));
    // Something that signs with a handle (a comment) asked for one.
    document.addEventListener("apricity:choose-handle", () => void (this.account ? this.open("handle") : this.open("signin")));
    void this.refresh();
  }

  /** Re-read who is signed in and redraw the header. Never throws. */
  async refresh(): Promise<void> {
    try {
      this.account = await this.deps.currentAccount();
    } catch {
      this.account = null;
    }
    try {
      this.handle = this.account ? await this.deps.myHandle(ownersOf(this.account)) : undefined;
    } catch {
      this.handle = undefined;
    }
    this.host.replaceChildren(
      ...(this.account ? this.pill(this.account) : [el("button", { className: "acct-in", type: "button", onclick: () => this.open("signin") }, "Sign in")]),
    );
    // First sign-in (or any visit until one is chosen): ask for the public handle.
    if (this.account && !this.handle && !this.askedForHandle && !this.dlg.open) {
      this.askedForHandle = true;
      this.open("handle");
    }
  }

  private pill(a: Account): HTMLElement[] {
    const name = this.handle ? `@${this.handle}` : displayName(a);
    const menu = el("div", { className: "acct-menu", role: "menu", hidden: true });
    const btn = el(
      "button",
      { className: "acct-pill", type: "button", title: "Account", ariaHasPopup: "menu", ariaExpanded: "false" },
      el("span", { className: "acct-avatar", ariaHidden: "true" }, this.handle ? this.handle[0]!.toUpperCase() : initial(a)),
      el("span", { className: "acct-email" }, name),
    );
    const close = () => {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    };
    const item = (label: string, fn: () => void) => el("button", { className: "acct-item", type: "button", role: "menuitem", onclick: () => (close(), fn()) }, label);
    menu.append(
      el("div", { className: "acct-who" }, name, ...(this.handle ? [el("small", {}, displayName(a))] : [])),
      item(this.handle ? "Change handle" : "Choose your handle", () => this.open("handle")),
      item("Account settings", () => this.open("account")),
      ...(a.admin ? [item("Import library from bucket", () => this.open("import"))] : []),
      item("Sign out", () => void this.signOut()),
    );
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.setAttribute("aria-expanded", String(!menu.hidden));
    });
    const away = (e: Event) => {
      if (!menu.isConnected) return document.removeEventListener("click", away);
      if (!menu.hidden && !this.host.contains(e.target as Node)) close();
    };
    document.addEventListener("click", away);
    menu.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Escape" && (close(), btn.focus()));
    return [menu, btn];
  }

  private async signOut() {
    try {
      await this.deps.signOutAccount();
    } catch {
      /* stay as we are; the header refresh below shows the truth */
    }
    await this.refresh();
  }

  open(view: View) {
    this.view = view;
    this.render();
    if (!this.dlg.open) this.dlg.showModal();
    this.focusFirst();
  }

  private focusFirst() {
    (this.dlg.querySelector<HTMLElement>("input:not([type=hidden]), button.primary, button") ?? this.dlg).focus();
  }

  private go(view: View) {
    this.view = view;
    this.render();
    this.focusFirst();
  }

  private error(msg: string) {
    const box = this.dlg.querySelector<HTMLElement>(".acct-error");
    if (box) box.textContent = msg;
  }

  private form(title: string, fields: HTMLElement[], submitLabel: string, onSubmit: (data: FormData) => Promise<void>, extra: HTMLElement[] = []) {
    const submit = el("button", { className: "btn primary", type: "submit" }, submitLabel);
    const form = el(
      "form",
      { className: "acct-form", noValidate: false },
      el("h2", { id: "acct-title" }, title),
      ...fields,
      el("p", { className: "acct-error", role: "alert" }),
      el("div", { className: "acct-actions" }, submit, el("button", { className: "btn", type: "button", onclick: () => this.dlg.close() }, "Cancel")),
      ...extra,
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      this.error("");
      submit.disabled = true;
      try {
        await onSubmit(new FormData(form));
      } catch (err) {
        this.error((err as Error).message || "Something went wrong.");
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  private field(label: string, name: string, type: string, autocomplete: string, value = "", extra: Record<string, unknown> = {}) {
    return el("label", { className: "acct-field" }, label, el("input", { name, type, autocomplete, value, required: true, ...extra }));
  }

  private link(text: string, onclick: () => void) {
    return el("button", { className: "acct-link", type: "button", onclick }, text);
  }

  private google(withDivider = true): HTMLElement[] {
    if (!this.deps.googleAvailable()) return [];
    return [
      ...(withDivider ? [el("div", { className: "acct-or" }, "or")] : []),
      el(
        "button",
        {
          className: "btn acct-google",
          type: "button",
          onclick: async () => {
            try {
              await this.deps.signInWithGoogle();
            } catch (err) {
              this.error((err as Error).message);
            }
          },
        },
        "Sign in with Google",
      ),
    ];
  }

  private render() {
    if (this.view === "signin" && !this.deps.emailLoginAvailable() && this.deps.googleAvailable()) {
      // Google-only pool: no password or create-account forms at all.
      this.dlg.replaceChildren(
        el(
          "div",
          { className: "acct-form" },
          el("h2", { id: "acct-title" }, "Sign in"),
          el("p", { className: "acct-error", role: "alert" }),
          ...this.google(false),
          el("div", { className: "acct-actions" }, el("button", { className: "btn", type: "button", onclick: () => this.dlg.close() }, "Cancel")),
        ),
      );
    } else if (this.view === "signin") {
      this.dlg.replaceChildren(
        this.form(
          "Sign in",
          [this.field("Email", "email", "email", "username", this.email), this.field("Password", "password", "password", "current-password")],
          "Sign in",
          async (d) => {
            this.email = String(d.get("email"));
            await this.afterStep(await this.deps.signInWithPassword(this.email, String(d.get("password"))));
          },
          [...this.google(), el("p", { className: "acct-alt" }, "No account yet? ", this.link("Create account", () => this.go("signup")))],
        ),
      );
    } else if (this.view === "signup") {
      this.dlg.replaceChildren(
        this.form(
          "Create account",
          [
            this.field("Email", "email", "email", "username", this.email),
            this.field("Password", "password", "password", "new-password", "", { minLength: 8 }),
          ],
          "Create account",
          async (d) => {
            this.email = String(d.get("email"));
            const password = String(d.get("password"));
            const step = await this.deps.signUpWithPassword(this.email, password);
            if (step.kind === "confirm-sign-up") this.pendingPassword = password;
            await this.afterStep(step);
          },
          [el("p", { className: "acct-alt" }, "Already have an account? ", this.link("Sign in", () => this.go("signin")))],
        ),
      );
    } else if (this.view === "confirm") {
      const note = el("p", { className: "acct-note", role: "status" }, `We emailed a confirmation code to ${this.email}.`);
      this.dlg.replaceChildren(
        this.form(
          "Confirm your email",
          [note, this.field("Confirmation code", "code", "text", "one-time-code", "", { inputMode: "numeric", pattern: "[0-9]*" })],
          "Confirm",
          async (d) => {
            await this.deps.confirmSignUpCode(this.email, String(d.get("code")));
            const password = this.pendingPassword;
            this.pendingPassword = "";
            if (!password) return this.go("signin"); // confirmed on a later visit: sign in normally
            await this.afterStep(await this.deps.signInWithPassword(this.email, password));
          },
          [
            el("p", { className: "acct-alt" }, this.link("Resend code", async () => {
              try {
                await this.deps.resendConfirmationCode(this.email);
                note.textContent = `We sent a new code to ${this.email}.`;
                this.error("");
              } catch (err) {
                this.error((err as Error).message);
              }
            })),
          ],
        ),
      );
    } else if (this.view === "account") {
      const a = this.account;
      this.dlg.replaceChildren(
        el(
          "div",
          { className: "acct-form" },
          el("h2", { id: "acct-title" }, "Account"),
          el("p", { className: "acct-note" }, this.handle ? `@${this.handle} · ` : "", a ? displayName(a) : "", " (only you see your email)"),
          el("p", { className: "acct-groups" }, a?.groups.length ? `Groups: ${a.groups.join(", ")}` : "No groups yet."),
          el(
            "div",
            { className: "acct-actions" },
            el("button", { className: "btn primary", type: "button", onclick: () => this.go("handle") }, this.handle ? "Change handle" : "Choose your handle"),
            ...(a?.admin ? [el("button", { className: "btn", type: "button", onclick: () => this.go("import") }, "Import library from bucket")] : []),
            el("button", { className: "btn", type: "button", onclick: () => this.dlg.close() }, "Close"),
          ),
        ),
      );
    } else if (this.view === "handle") {
      this.renderHandle();
    } else {
      this.renderImport();
    }
  }

  /** Choose (or change) the public handle, checking availability as the person types. */
  private renderHandle() {
    const a = this.account;
    if (!a) return this.dlg.close();
    const first = !this.handle;
    const input = el("input", {
      name: "handle",
      type: "text",
      autocomplete: "off",
      spellcheck: false,
      maxLength: HANDLE_MAX + 1,
      required: true,
      value: this.handle ?? suggestHandle(a.email),
    }) as HTMLInputElement;
    const status = el("p", { className: "acct-note", role: "status" });
    let seq = 0;
    const check = async () => {
      const mine = ++seq;
      const h = normalizeHandle(input.value);
      const problem = handleProblem(h);
      if (problem || h === this.handle) return void (status.textContent = problem ?? "That's your handle now.");
      status.textContent = "Checking…";
      try {
        const free = await this.deps.handleFree(h);
        if (mine === seq) status.textContent = free ? `@${h} is free.` : `@${h} is taken.`;
      } catch {
        if (mine === seq) status.textContent = "";
      }
    };
    input.addEventListener("input", () => void check());
    this.dlg.replaceChildren(
      this.form(
        first ? "Choose your handle" : "Change your handle",
        [
          el(
            "p",
            { className: "acct-note" },
            first
              ? "Pick the name people see on what you make and share, like @ryan. Your email stays private."
              : "Your scores and clips will show the new handle. Clip names you already made keep theirs.",
          ),
          el("label", { className: "acct-field" }, "Handle", el("span", { className: "acct-handle" }, "@", input)),
          status,
        ],
        first ? "Use this handle" : "Change handle",
        async (d) => {
          const r = await this.deps.claimHandle(String(d.get("handle")), ownersOf(a));
          if (!r.ok) throw new Error(r.why);
          this.handle = r.handle;
          this.dlg.close();
          await this.refresh();
        },
      ),
    );
    if (first) {
      const later = this.dlg.querySelector<HTMLButtonElement>(".acct-actions button:not(.primary)");
      if (later) later.textContent = "Later";
    }
    void check();
  }

  private async afterStep(step: AuthStep) {
    if (step.kind === "signed-in") {
      this.pendingPassword = "";
      this.dlg.close();
      await this.refresh();
      this.deps.announce();
    } else if (step.kind === "confirm-sign-up") {
      this.email = step.email;
      this.go("confirm");
    } else {
      this.error("This account needs a sign-in step this page does not support yet.");
    }
  }

  private renderImport() {
    const bar = el("progress", { max: 1, value: 0 });
    const line = el("p", { className: "acct-note", role: "status" }, "Starting…");
    const result = el("div", { className: "acct-result" });
    const err = el("p", { className: "acct-error", role: "alert" });
    const stop = el("button", { className: "btn", type: "button" }, "Stop");
    const close = el("button", { className: "btn", type: "button", onclick: () => this.dlg.close() }, "Close");
    close.hidden = true;
    this.dlg.replaceChildren(
      el("div", { className: "acct-form" }, el("h2", { id: "acct-title" }, "Import library from bucket"), bar, line, err, result, el("div", { className: "acct-actions" }, stop, close)),
    );
    const ctl = (this.abort = new AbortController());
    stop.addEventListener("click", () => ctl.abort());
    void (async () => {
      try {
        const s = await this.deps.importLibrary({
          signal: ctl.signal,
          onProgress: (p) => {
            bar.max = Math.max(1, p.total);
            bar.value = p.done;
            line.textContent =
              p.phase === "done" ? "Finished." : p.phase === "checking" ? "Checking your account…" : `${p.model}: ${p.phase === "listing" ? "listing" : `${p.done} of ${p.total}`} · ${p.created} created, ${p.updated} updated, ${p.failed} failed`;
          },
        });
        line.textContent = `${s.aborted ? "Stopped" : "Done"}: ${s.created} created, ${s.updated} updated, ${s.failed.length} failed.`;
        if (s.failed.length) {
          result.replaceChildren(
            el("ul", { className: "acct-failed" }, ...s.failed.slice(0, 50).map((f) => el("li", {}, `${f.key}: ${f.error}`))),
            ...(s.failed.length > 50 ? [el("p", { className: "acct-note" }, `…and ${s.failed.length - 50} more.`)] : []),
          );
        }
        this.deps.announce();
      } catch (e) {
        line.textContent = "";
        err.textContent = (e as Error).message || "Import failed.";
      } finally {
        stop.hidden = true;
        close.hidden = false;
        close.focus();
      }
    })();
  }
}
