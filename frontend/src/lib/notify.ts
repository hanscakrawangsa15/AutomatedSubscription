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
 *
 * keepalive:true is load-bearing, not decoration — confirmed via a real
 * incident: a subscriber closed their wallet/tab right after a successful
 * subscribe(), and this request never reached the server at all (zero
 * trace in server logs despite the server being up the whole time). A
 * plain fetch() can be aborted mid-flight when the page unloads; keepalive
 * tells the browser to finish this (small — well under the ~64KB keepalive
 * budget) request in the background regardless. Kept as a self-healing
 * reconciliation in scripts/keeper.js too, for every other way this same
 * write could fail (network drop, notify-server downtime, ...).
 */
export async function reportSubscription(report: SubscriptionReport): Promise<boolean> {
  try {
    const res = await fetch(`${NOTIFY_API_URL}/api/subscribers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export type DbSubscriptionRow = {
  chain_name: string;
  chain_id: number | null;
  plan_id: number | null;
  plan_label: string | null;
  periods_paid: number | null;
  next_charge_at: string | null;
  status: "active" | "overdue" | "expired" | "inactive" | null;
  tx_hash: string | null;
};

/**
 * Fast-path lookup: every row this wallet has ever touched, across every
 * chain, straight from our own DB — used right after a wallet connects so
 * the UI can render Manage Subscription immediately instead of waiting on
 * live on-chain reads. This is a display optimization only — never treat
 * an empty/stale result here as proof the wallet ISN'T subscribed; the
 * caller is expected to still confirm against the chain in the background.
 * Best-effort: an unreachable notify server just means no fast path, not a
 * blocker — the caller falls back to the on-chain check either way.
 */
export async function lookupSubscriptionsByWallet(address: string): Promise<DbSubscriptionRow[]> {
  try {
    const res = await fetch(`${NOTIFY_API_URL}/api/subscribers/by-wallet/${address}`);
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.rows) ? body.rows : [];
  } catch {
    return [];
  }
}
