import { getTronSubscriptionManagerRead, getTronUsdcRead, isTronConfigured } from "./tronContracts";
import { classifyInterval, formatDuration, type PlanKind } from "./plans";

export { formatDuration };

export type TronPlanInfo = {
  id: number;
  priceRaw: bigint;
  price: string;
  intervalSeconds: number;
  intervalDays: number;
  graceDays: number;
  active: boolean;
  kind: PlanKind;
};

function formatUnitsPlain(raw: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, "0")}`.replace(/0+$/, "").replace(/\.$/, "");
}

// Uses the read-only TronWeb instance (no TronLink required) so plans are
// visible before connecting, mirroring lib/plans.ts's fetchPlans on the EVM
// side — except addresses aren't chainId-keyed (see lib/tronContracts.ts).
export async function fetchTronPlans(): Promise<TronPlanInfo[]> {
  if (!isTronConfigured()) return [];
  const manager = getTronSubscriptionManagerRead();
  const usdc = getTronUsdcRead();
  if (!manager || !usdc) return [];
  const [count, decimals] = await Promise.all([manager.planCount().call(), usdc.decimals().call()]);

  const plans: TronPlanInfo[] = [];
  for (let i = 0; i < Number(count); i++) {
    const p = await manager.plans(i).call();
    const intervalDays = Number(p.interval) / 86400;
    plans.push({
      id: i,
      priceRaw: BigInt(p.price),
      price: formatUnitsPlain(BigInt(p.price), Number(decimals)),
      intervalSeconds: Number(p.interval),
      intervalDays,
      graceDays: Number(p.gracePeriod) / 86400,
      active: p.active,
      kind: classifyInterval(intervalDays),
    });
  }
  return plans;
}
