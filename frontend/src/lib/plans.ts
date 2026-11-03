import { formatUnits, type Provider } from "ethers";
import { getChainAddresses, getSubscriptionManager, getMockUsdc } from "./contracts";

export type PlanKind = "monthly" | "yearly" | "test" | "other";

export type PlanInfo = {
  id: number;
  chainId: number;
  tokenSuffix: string;
  tokenSymbol: string;
  tokenAddress: string;
  priceRaw: bigint;
  price: string;
  decimals: number;
  intervalSeconds: number;
  intervalDays: number;
  graceDays: number;
  active: boolean;
  kind: PlanKind;
  /**
   * Set only for partner-discount plans (SubscriptionManager.setPromo): after
   * `periods` payments the contract bills `successorId` at `successorPriceRaw`
   * instead. Only read when asked for (see fetchPlans' includePromo).
   */
  promo?: { periods: number; successorId: number; successorPriceRaw: bigint };
};

export function classifyInterval(days: number): PlanKind {
  if (days >= 25 && days <= 45) return "monthly";
  if (days >= 300 && days <= 400) return "yearly";
  if (days < 1) return "test";
  return "other";
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86400)} days`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wraps the raw fetch with a couple of short retries. On a page that also
// juggles several other chains' RPC connections at once (e.g. the dev-mode
// Hardhat Local provider retrying every second in the background), the very
// first read on mount can lose a race against that contention and fail
// transiently — with no retry, that error stuck around forever since
// nothing re-triggers the fetch until chainId itself changes.
export async function fetchPlans(
  runner: Provider,
  chainId: number | bigint,
  suffix = "",
  includePromo = false,
): Promise<PlanInfo[]> {
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchPlansOnce(runner, chainId, suffix, includePromo);
    } catch (err) {
      if (attempt === attempts) throw err;
      await sleep(600 * attempt);
    }
  }
  return [];
}

async function fetchPlansOnce(
  runner: Provider,
  chainId: number | bigint,
  suffix: string,
  includePromo: boolean,
): Promise<PlanInfo[]> {
  const addrs = getChainAddresses(chainId, suffix);
  if (!addrs) return [];
  const manager = getSubscriptionManager(runner, chainId, suffix);
  const usdc = getMockUsdc(runner, chainId, suffix);
  const [count, decimals, symbol] = await Promise.all([manager.planCount(), usdc.decimals(), usdc.symbol()]);
  const chainIdNum = Number(chainId);

  // Fired in parallel (not a sequential for-await loop) so every plans(i)
  // call is pending at once — that's what lets getReadProvider's batching
  // combine them into one HTTP request instead of N separate round trips.
  const rawPlans = await Promise.all(Array.from({ length: Number(count) }, (_, i) => manager.plans(i)));
  // Promo config is only fetched on the partner-discount pages — the regular
  // pricing flow doesn't need it, so it doesn't pay for the extra reads. A
  // manager without promos() (v1) just yields "no promo" for every plan.
  const rawPromos = includePromo
    ? await Promise.all(Array.from({ length: Number(count) }, (_, i) => manager.promos(i).catch(() => null)))
    : [];
  return rawPlans.map((p, i) => {
    const rp = rawPromos[i];
    const successor = rp && rp.periods > 0n ? rawPlans[Number(rp.successorId)] : undefined;
    const intervalDays = Number(p.interval) / 86400;
    return {
      id: i,
      chainId: chainIdNum,
      tokenSuffix: suffix,
      tokenSymbol: symbol,
      tokenAddress: addrs.usdc,
      priceRaw: p.price,
      price: formatUnits(p.price, decimals),
      decimals: Number(decimals),
      intervalSeconds: Number(p.interval),
      intervalDays,
      graceDays: Number(p.gracePeriod) / 86400,
      active: p.active,
      kind: classifyInterval(intervalDays),
      promo:
        rp && successor
          ? { periods: Number(rp.periods), successorId: Number(rp.successorId), successorPriceRaw: successor.price }
          : undefined,
    };
  });
}
