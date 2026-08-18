const NOTIFY_API_URL = import.meta.env.VITE_NOTIFY_API_URL || "http://localhost:4000";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SubscriptionReport = {
  address: string;
  chainName: string;
  /** null for chains with no numeric chain id (Solana) */
  chainId: number | null;
  email?: string;
  trafficSource?: string | null;
  planId: number;
  planLabel: string;
  txHash: string;
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
