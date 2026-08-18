export type BillingCycle = "monthly" | "yearly";

export type PricingTier = {
  id: "starter" | "basic" | "advance";
  name: string;
  icon: string;
  bestDeal?: boolean;
  monthlyPrice: number;
  /** undefined = this tier has no yearly option (matches the Starter tier in the reference design) */
  yearlyPrice?: number;
  features: string[];
};

// Prices in USD-equivalent stablecoin units (USDC on Base/Ethereum, USDT on
// BNB Chain — 1:1 with USD by design). Yearly = monthly * 12 * 0.8 (20%
// off), matching the "Pay Annually 20% OFF" toggle.
export const PRICING_TIERS: PricingTier[] = [
  {
    id: "starter",
    name: "Starter",
    icon: "🌐",
    monthlyPrice: 10,
    features: ["2 Xenorize DCA bots", "2 Xenorize Grid bots", "2 Xenoarc bots", "1 Xenorize Margin Leverage bots"],
  },
  {
    id: "basic",
    name: "Basic",
    icon: "🚀",
    bestDeal: true,
    monthlyPrice: 29,
    yearlyPrice: 278.4,
    features: ["5 Xenorize DCA bots", "5 Xenorize Grid bots", "5 Xenoarc bots", "3 Xenorize Margin Leverage bots"],
  },
  {
    id: "advance",
    name: "Advance",
    icon: "⚛️",
    monthlyPrice: 69,
    yearlyPrice: 662.4,
    features: ["20 Xenorize DCA bots", "20 Xenorize Grid bots", "20 Xenoarc bots", "10 Xenorize Margin Leverage bots"],
  },
];

export function priceForCycle(tier: PricingTier, cycle: BillingCycle): number | undefined {
  return cycle === "monthly" ? tier.monthlyPrice : tier.yearlyPrice;
}

// Fixed plan.id order scripts/create-plans-safe.js always creates the
// 5-tier set in — used as a fallback below for tokens whose price isn't
// ~1:1 with USD (WETH/WBNB and similar), where a $29 tier might be priced
// as 0.0152 WETH on-chain: nowhere near $29 numerically, so the
// price-proximity match below can never succeed for them.
const TIER_PLAN_ID: Record<string, number> = {
  "starter:monthly": 0,
  "basic:monthly": 1,
  "basic:yearly": 2,
  "advance:monthly": 3,
  "advance:yearly": 4,
};

// Matches a pricing tier + billing cycle to a real on-chain plan — the
// contract has no concept of "Starter/Basic/Advance" tiers, only a flat
// list of (price, interval) plans created by the owner. Shared by
// PricingTiers.tsx (button enabled/disabled state) and App.tsx
// (re-resolving a tier choice against whichever chain the wallet ends up
// connected to, so switching networks doesn't just discard the selection).
export function findOnChainPlan<P extends { active: boolean; kind: string; price: string; id: number }>(
  plans: P[] | null,
  tier: PricingTier,
  cycle: BillingCycle,
): P | undefined {
  const targetPrice = priceForCycle(tier, cycle);
  if (targetPrice === undefined || !plans) return undefined;
  const kind = cycle === "monthly" ? "monthly" : "yearly";

  const byPrice = plans.find((p) => p.active && p.kind === kind && Math.abs(Number(p.price) - targetPrice) < 0.01);
  if (byPrice) return byPrice;

  // No stablecoin-range ($10ish) monthly plan anywhere in this list means
  // this token's price-matching can never work (WETH/WBNB territory) —
  // fall back to the fixed creation-order id. A real stablecoin chain
  // always has a Starter-monthly plan near $10, so this branch never
  // triggers for USDC/USDT and can't accidentally mismatch a plan there.
  const looksLikeStablecoin = plans.some((p) => p.kind === "monthly" && Math.abs(Number(p.price) - 10) < 0.01);
  if (looksLikeStablecoin) return undefined;

  const expectedId = TIER_PLAN_ID[`${tier.id}:${cycle}`];
  if (expectedId === undefined) return undefined;
  return plans.find((p) => p.active && p.kind === kind && p.id === expectedId);
}
