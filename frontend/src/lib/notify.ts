const NOTIFY_API_URL = import.meta.env.VITE_NOTIFY_API_URL || "http://localhost:4000";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SubscriptionReport = {
  address: string;
  chainName: string;
  chainId: number;
  email?: string;
  trafficSource?: string | null;
  planId: number;
  planLabel: string;
  txHash: string;
  // Rendered directly into the confirmation email (see server/index.js's
  // /api/subscribers handler) — kept as pre-formatted strings so the
  // server doesn't need its own copy of the bigint/decimals formatting
  // logic that produced them in ConfirmSubscription.tsx.
  amountLabel?: string;
  intervalLabel?: string;
  // The contract's own lifetime periodsPaid counter (Subscription struct) —
  // read fresh off-chain right after the action that triggered this report,
  // so it's always the authoritative count rather than something derived
  // client-side. Lets the admin panel show how many times a wallet has
  // ever been successfully charged (initial subscribe + every renewal).
  periodsPaid?: number;
  // nextChargeAt as unix seconds (Subscription.nextChargeAt) — same
  // "read fresh off-chain" reasoning as periodsPaid above.
  nextChargeAt?: number;
  // Mirrors the contract's Status enum, lowercased — see server/index.js's
  // SUBSCRIPTION_STATUSES for the accepted values.
  status?: "active" | "overdue" | "expired" | "inactive";
  // Whether the action that triggered this report actually moved funds —
  // distinct from "did the transaction succeed", since e.g. chargeDue can
  // succeed as a transaction while still failing to charge (see the
  // contract's insufficient-allowance/balance branch).
  renewalResult?: "success" | "failed";
};

/**
 * Upserts this subscription into the `subscribers` table (keyed by
 * wallet_address + chain_name) — called once a subscribe() transaction
 * confirms on-chain, regardless of whether the user filled in an email, so
 * plan/tx details are captured for every real subscriber. Best-effort:
 * failures are swallowed so a missing/offline notify server never blocks
 * subscribing.
 */
export async function reportSubscription(report: SubscriptionReport): Promise<boolean> {
  try {
    const res = await fetch(`${NOTIFY_API_URL}/api/subscribers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    return res.ok;
  } catch {
    return false;
  }
}
