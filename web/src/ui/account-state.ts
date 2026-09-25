// Pure helpers for the account pill and the empty states of the data views (no DOM, no auth imports).

const PROVIDER_ID = /^(google|facebook|signinwithapple|amazon)_[0-9a-f-]+$/i;
const EMAIL = /^[^@\s]+@[^@\s]+$/;

/** What the pill shows: the email, or "Signed in" when it is missing or a raw provider/Cognito id. */
export function displayName(account: { email?: string | null } | null | undefined): string {
  const e = (account?.email ?? "").trim();
  return e && EMAIL.test(e) && !PROVIDER_ID.test(e) ? e : "Signed in";
}

/** The letter in the round avatar. */
export function initial(account: { email?: string | null } | null | undefined): string {
  const n = displayName(account);
  return n === "Signed in" ? "•" : n[0]!.toUpperCase();
}

export type EmptyKind = "signed-out" | "no-access" | "empty";

export function emptyKind(s: { signedIn: boolean; refused: boolean; empty: boolean }): EmptyKind | null {
  if (!s.signedIn) return "signed-out";
  if (s.refused) return "no-access";
  return s.empty ? "empty" : null;
}

const TEXT: Record<"library" | "score", Record<EmptyKind, string>> = {
  library: {
    "signed-out": "Sign in to see the library.",
    "no-access": "Your account doesn't have access to the library yet. Ask an admin to add you to a group.",
    empty: "The library is empty. An admin can import it from the account menu.",
  },
  score: {
    "signed-out": "Sign in to see your scores.",
    "no-access": "Your account doesn't have access to the library yet. Ask an admin to add you to a group.",
    empty: "No scores yet.",
  },
};
export const emptyText = (view: "library" | "score", k: EmptyKind) => TEXT[view][k];
