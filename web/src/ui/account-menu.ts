import type { Account } from "../data/auth";
import type { Route } from "../route";

export interface AccountMenuDestination {
  label: string;
  route: Route;
}

/** Personal destinations are only available after the account menu is authenticated. */
export function accountMenuDestinations(account: Account | null): AccountMenuDestination[] {
  return account ? [{ label: "My Labs", route: { page: "labs" } }] : [];
}
