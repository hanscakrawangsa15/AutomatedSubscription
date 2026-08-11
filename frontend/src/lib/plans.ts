import { formatUnits, type Provider } from "ethers";
import { getSubscriptionManager, getMockUsdc, isChainDeployed } from "./contracts";

export type PlanKind = "monthly" | "yearly" | "test" | "other";

export type PlanInfo = {
  id: number;
  chainId: number;
  priceRaw: bigint;
  price: string;
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

export async function fetchPlans(runner: Provider, chainId: number | bigint): Promise<PlanInfo[]> {
  if (!isChainDeployed(chainId)) return [];
  const manager = getSubscriptionManager(runner, chainId);
  const usdc = getMockUsdc(runner, chainId);
  const [count, decimals] = await Promise.all([manager.planCount(), usdc.decimals()]);
  const chainIdNum = Number(chainId);

  const plans: PlanInfo[] = [];
  for (let i = 0; i < Number(count); i++) {
    const p = await manager.plans(i);
    const intervalDays = Number(p.interval) / 86400;
    plans.push({
      id: i,
      chainId: chainIdNum,
      priceRaw: p.price,
      price: formatUnits(p.price, decimals),
      intervalSeconds: Number(p.interval),
      intervalDays,
      graceDays: Number(p.gracePeriod) / 86400,
      active: p.active,
      kind: classifyInterval(intervalDays),
    });
  }
  return plans;
}
