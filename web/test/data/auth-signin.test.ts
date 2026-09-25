import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as auth from "../../src/data/auth.ts";
import type { AuthApi } from "../../src/data/auth.ts";

function named(name: string, message = "") {
  return Object.assign(new Error(message), { name });
}

/** Stub of aws-amplify/auth that records calls; each method can be overridden. */
function stub(over: Partial<AuthApi> = {}) {
  const calls: Array<[string, unknown]> = [];
  const rec = <T>(n: string, v: T) => async (i?: unknown) => (calls.push([n, i]), v);
  const api: AuthApi = {
    signIn: rec("signIn", { isSignedIn: true }) as any,
    signUp: rec("signUp", { isSignUpComplete: false, nextStep: { signUpStep: "CONFIRM_SIGN_UP" } }) as any,
    confirmSignUp: rec("confirmSignUp", { isSignUpComplete: true }) as any,
    resendSignUpCode: rec("resendSignUpCode", {}) as any,
    signOut: rec("signOut", undefined) as any,
    getCurrentUser: rec("getCurrentUser", { userId: "sub-1", username: "user-1", signInDetails: { loginId: "a@b.c" } }) as any,
    fetchAuthSession: rec("fetchAuthSession", { tokens: { idToken: { payload: { email: "a@b.c", "cognito:groups": ["members"] } }, accessToken: { payload: { "cognito:groups": ["admins", "members"] } } } }) as any,
    signInWithRedirect: rec("signInWithRedirect", undefined) as any,
    ...over,
  };
  auth.setAuthApiLoader(async () => api);
  return calls;
}

let events = 0;
const onChanged = () => events++;
beforeEach(() => {
  events = 0;
  (globalThis as any).document = new EventTarget();
  document.addEventListener("apricity:auth-changed", onChanged);
  (globalThis as any).CustomEvent ??= class extends Event {};
});
afterEach(() => {
  auth.setAuthApiLoader(null);
  delete (globalThis as any).document;
});

describe("sign in", () => {
  it("signs in with the trimmed email and announces the change", async () => {
    const calls = stub();
    assert.deepEqual(await auth.signInWithPassword(" a@b.c ", "pw"), { kind: "signed-in" });
    assert.deepEqual(calls[0], ["signIn", { username: "a@b.c", password: "pw" }]);
    assert.equal(events, 1);
  });
  it("an unconfirmed user is sent to the code step, not shown an error", async () => {
    stub({ signIn: async () => { throw named("UserNotConfirmedException"); } });
    assert.deepEqual(await auth.signInWithPassword("a@b.c", "pw"), { kind: "confirm-sign-up", email: "a@b.c" });
    stub({ signIn: async () => ({ isSignedIn: false, nextStep: { signInStep: "CONFIRM_SIGN_UP" } }) });
    assert.deepEqual(await auth.signInWithPassword("a@b.c", "pw"), { kind: "confirm-sign-up", email: "a@b.c" });
    assert.equal(events, 0);
  });
  it("already signed in counts as signed in", async () => {
    stub({ signIn: async () => { throw named("UserAlreadyAuthenticatedException"); } });
    assert.deepEqual(await auth.signInWithPassword("a@b.c", "pw"), { kind: "signed-in" });
  });
  it("steps it cannot handle are reported, not swallowed", async () => {
    stub({ signIn: async () => ({ isSignedIn: false, nextStep: { signInStep: "RESET_PASSWORD" } }) });
    assert.deepEqual(await auth.signInWithPassword("a@b.c", "pw"), { kind: "unsupported", step: "RESET_PASSWORD" });
  });
  it("wrong password gives a clear message and never echoes the password", async () => {
    stub({ signIn: async () => { throw named("NotAuthorizedException", "Incorrect username or password. secret-pw"); } });
    await assert.rejects(auth.signInWithPassword("a@b.c", "secret-pw"), (e: Error) => e.message === "Wrong email or password." && !e.message.includes("secret-pw"));
    assert.equal(events, 0);
  });
});

describe("sign up and confirm", () => {
  it("sign up passes the email attribute and moves to the code step", async () => {
    const calls = stub();
    assert.deepEqual(await auth.signUpWithPassword("a@b.c", "pw"), { kind: "confirm-sign-up", email: "a@b.c" });
    assert.deepEqual((calls[0][1] as any).options, { userAttributes: { email: "a@b.c" } });
  });
  it("an address outside the allow-list says so", async () => {
    stub({ signUp: async () => { throw named("UserLambdaValidationException", "PreSignUp failed with error Sign-up not allowed."); } });
    await assert.rejects(auth.signUpWithPassword("x@y.z", "pw"), /not allowed to sign up/);
  });
  it("confirm, resend and their errors", async () => {
    const calls = stub();
    await auth.confirmSignUpCode("a@b.c", " 123456 ");
    await auth.resendConfirmationCode("a@b.c");
    assert.deepEqual(calls.map((c) => c[0]), ["confirmSignUp", "resendSignUpCode"]);
    assert.deepEqual(calls[0][1], { username: "a@b.c", confirmationCode: "123456" });
    stub({ confirmSignUp: async () => { throw named("ExpiredCodeException"); } });
    await assert.rejects(auth.confirmSignUpCode("a@b.c", "1"), /expired/);
    stub({ confirmSignUp: async () => { throw named("CodeMismatchException"); } });
    await assert.rejects(auth.confirmSignUpCode("a@b.c", "1"), /not right/);
  });
  it("maps the other Cognito errors", () => {
    const m = (n: string, msg = "") => auth.friendlyAuthError(named(n, msg)).message;
    assert.match(m("UsernameExistsException"), /already exists/);
    assert.match(m("InvalidPasswordException"), /too weak/);
    assert.match(m("LimitExceededException"), /Too many/);
    assert.match(m("UserNotConfirmedException"), /not confirmed/);
    assert.match(m("Whatever", "internal detail"), /Sign-in failed/);
    assert.ok(!m("Whatever", "internal detail").includes("internal detail"));
  });
});

describe("account and sign out", () => {
  it("reads email, groups (both tokens) and the admin flag", async () => {
    stub();
    assert.deepEqual(await auth.currentAccount(), { sub: "sub-1", username: "user-1", email: "a@b.c", groups: ["admins", "members"], admin: true });
  });
  it("a plain member is not an admin", async () => {
    stub({ fetchAuthSession: async () => ({ tokens: { idToken: { payload: { email: "m@b.c", "cognito:groups": ["members"] } } } }) });
    const a = await auth.currentAccount();
    assert.equal(a?.admin, false);
    assert.deepEqual(a?.groups, ["members"]);
  });
  it("signed out is null, never a throw", async () => {
    stub({ getCurrentUser: async () => { throw named("UserUnAuthenticatedException"); } });
    assert.equal(await auth.currentAccount(), null);
  });
  it("a failing session lookup falls back to the user's login id", async () => {
    stub({ fetchAuthSession: async () => { throw new Error("offline"); } });
    assert.equal((await auth.currentAccount())?.email, "a@b.c");
  });
  it("sign out calls Cognito and announces", async () => {
    const calls = stub();
    await auth.signOutAccount();
    assert.equal(calls[0][0], "signOut");
    assert.equal(events, 1);
  });
  it("groupsFromPayload tolerates junk", () => {
    assert.deepEqual(auth.groupsFromPayload(undefined), []);
    assert.deepEqual(auth.groupsFromPayload({ "cognito:groups": "admins" }), []);
    assert.deepEqual(auth.groupsFromPayload({ "cognito:groups": ["a", 3, "b"] }), ["a", "b"]);
  });
});
