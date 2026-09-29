import { test } from "node:test";
import assert from "node:assert/strict";

import { accountMenuDestinations } from "../src/ui/account-menu.ts";
import { href } from "../src/route.ts";
import type { Account } from "../src/data/auth.ts";

const account: Account = {
  sub: "user-1",
  username: "user-1",
  email: "person@example.com",
  groups: [],
  admin: false,
};

test("My Labs is an authenticated account-menu destination for /labs", () => {
  assert.deepEqual(accountMenuDestinations(null), []);
  assert.deepEqual(
    accountMenuDestinations(account).map(({ label, route }) => ({ label, href: href(route) })),
    [{ label: "My Labs", href: "/labs" }],
  );
});
