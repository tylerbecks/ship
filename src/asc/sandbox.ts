// Sandbox Apple Accounts, for testing in-app purchases and subscriptions.
// The API can list and change them and clear their purchases, but not make
// one: that's App Store Connect → Users and Access → Sandbox.

import { type Resource, all, one, patch, post } from "./client";

/** How fast a sandbox subscription renews: Apple's monthly renewal speeds, as ship spells them. */
export const RENEWAL_RATES = {
  "1h": "MONTHLY_RENEWAL_EVERY_ONE_HOUR",
  "30m": "MONTHLY_RENEWAL_EVERY_THIRTY_MINUTES",
  "15m": "MONTHLY_RENEWAL_EVERY_FIFTEEN_MINUTES",
  "5m": "MONTHLY_RENEWAL_EVERY_FIVE_MINUTES",
  "3m": "MONTHLY_RENEWAL_EVERY_THREE_MINUTES",
} as const;

export type RenewalRate = keyof typeof RENEWAL_RATES;

export interface SandboxTester {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  /** Apple's three-letter territory code, like USA. */
  territory: string | null;
  interruptPurchases: boolean;
  /** One of RENEWAL_RATES' values. */
  subscriptionRenewalRate: string | null;
  applePayCompatible: boolean;
}

interface SandboxAttributes {
  acAccountName?: string;
  firstName?: string | null;
  lastName?: string | null;
  territory?: string | null;
  interruptPurchases?: boolean;
  subscriptionRenewalRate?: string | null;
  applePayCompatible?: boolean;
}

export const toSandboxTester = ({ id, attributes }: Resource<SandboxAttributes>): SandboxTester => ({
  id,
  email: attributes.acAccountName ?? "",
  firstName: attributes.firstName ?? "",
  lastName: attributes.lastName ?? "",
  territory: attributes.territory ?? null,
  interruptPurchases: attributes.interruptPurchases ?? false,
  subscriptionRenewalRate: attributes.subscriptionRenewalRate ?? null,
  applePayCompatible: attributes.applePayCompatible ?? false,
});

/** The team's sandbox testers, by email. */
export async function sandboxTesters(): Promise<SandboxTester[]> {
  const { data } = await all<SandboxAttributes>("/v2/sandboxTesters?limit=200");
  return data.map(toSandboxTester).sort((a, b) => a.email.localeCompare(b.email));
}

export interface SandboxChanges {
  territory?: string;
  interruptPurchases?: boolean;
  subscriptionRenewalRate?: string;
}

/** Changes a tester's store, purchase interruptions, or renewal speed. */
export async function updateSandboxTester(id: string, changes: SandboxChanges): Promise<SandboxTester | undefined> {
  const updated = one(await patch<SandboxAttributes>(`/v2/sandboxTesters/${encodeURIComponent(id)}`, { data: { type: "sandboxTesters", id, attributes: changes } }));
  return updated && toSandboxTester(updated);
}

/** Clears testers' purchase history, so they can buy everything again. */
export async function clearPurchaseHistory(ids: string[]): Promise<void> {
  await post("/v2/sandboxTestersClearPurchaseHistoryRequest", {
    data: {
      type: "sandboxTestersClearPurchaseHistoryRequest",
      relationships: { sandboxTesters: { data: ids.map((id) => ({ type: "sandboxTesters", id })) } },
    },
  });
}
