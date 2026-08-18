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
export async function fetchPlans(runner: Provider, chainId: number | bigint, suffix = ""): Promise<PlanInfo[]> {
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchPlansOnce(runner, chainId, suffix);
    } catch (err) {
      if (attempt === attempts) throw err;
      await sleep(600 * attempt);
    }
  }
  return [];
}

async function fetchPlansOnce(runner: Provider, chainId: number | bigint, suffix: string): Promise<PlanInfo[]> {
  const addrs = getChainAddresses(chainId, suffix);
  if (!addrs) return [];
  const manager = getSubscriptionManager(runner, chainId, suffix);
  const usdc = getMockUsdc(runner, chainId, suffix);
  const [count, decimals, symbol] = await Promise.all([manager.planCount(), usdc.decimals(), usdc.symbol()]);
  const chainIdNum = Number(chainId);

  const plans: PlanInfo[] = [];
  for (let i = 0; i < Number(count); i++) {
    const p = await manager.plans(i);
    const intervalDays = Number(p.interval) / 86400;
    plans.push({
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
    });
  }
  return plans;
}
