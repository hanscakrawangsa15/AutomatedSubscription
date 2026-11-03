export type CampaignId = "tokocrypto";

export type Campaign = {
  id: CampaignId;
  name: string;
  /** Text on each pricing card's ribbon. */
  ribbon: string;
  /** Fixed prices (USD) per tier + cycle — NOT computed from the normal price. */
  prices: Partial<Record<PricingTier["id"], { monthly?: number; yearly?: number }>>;
};

export type BillingCycle = "monthly" | "yearly" | "test";

export type PricingTier = {
  id: "starter" | "basic" | "advance" | "test";
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
//
// Changing a price here does NOT touch existing subscribers: a plan's price
// is fixed on-chain at creation, so a price change means creating new plans
// (scripts/create-plans-safe.js) and deactivating the old ones
// (scripts/deactivate-plans-safe.js). Subscribers on an old plan keep paying
// the old price until they cancel — list every retired price in
// LEGACY_TIER_PRICES below so their plan still gets the right label.
export const PRICING_TIERS: PricingTier[] = [
  {
    id: "starter",
    name: "Starter",
    icon: "🌐",
    monthlyPrice: 15,
    features: ["2 Xenorize DCA bots", "2 Xenorize Grid bots", "2 Xenoarc bots", "1 Xenorize Margin Leverage bots"],
  },
  {
    id: "basic",
    name: "Basic",
    icon: "🚀",
    bestDeal: true,
    monthlyPrice: 39,
    yearlyPrice: 374.4,
    features: ["5 Xenorize DCA bots", "5 Xenorize Grid bots", "5 Xenoarc bots", "3 Xenorize Margin Leverage bots"],
  },
  {
    id: "advance",
    name: "Advance",
    icon: "⚛️",
    monthlyPrice: 79,
    yearlyPrice: 758.4,
    features: ["20 Xenorize DCA bots", "20 Xenorize Grid bots", "20 Xenoarc bots", "10 Xenorize Margin Leverage bots"],
  },
];

// Internal QA-only plan ($1, charges hourly — see scripts/create-test-plan-safe.js)
// for verifying the keeper's auto-charge flow on real mainnet without
// waiting a full 30-day cycle. Deliberately kept OUT of PRICING_TIERS (never
// shows in the customer-facing Monthly/Yearly grid) — PricingTiers.tsx
// surfaces it as its own small always-visible card instead.
export const TEST_TIER: PricingTier = {
  id: "test",
  name: "Test Plan",
  icon: "🧪",
  monthlyPrice: 1,
  features: [],
};

// Partner-discount campaigns. The prices are fixed by the partnership and are
// live on the SAME SubscriptionManager as the normal plans: scripts/
// create-tokocrypto-plans-safe.js creates one promo plan per entry below and
// links it (setPromo) to the normal plan the subscriber moves to afterwards —
// 12 discounted payments for monthly, 1 for yearly, then the normal price.
// A new campaign = a new entry here + its own plans on-chain, no redeploy.
export const CAMPAIGNS: Record<CampaignId, Campaign> = {
  tokocrypto: {
    id: "tokocrypto",
    name: "Tokocrypto",
    ribbon: "10% OFF",
    prices: {
      starter: { monthly: 13.5 },
      basic: { monthly: 35.1, yearly: 327.6 },
      advance: { monthly: 71.1, yearly: 663.6 },
    },
  },
};

export function priceForCycle(tier: PricingTier, cycle: BillingCycle, campaign?: CampaignId | null): number | undefined {
  if (campaign) {
    if (cycle === "test") return undefined; // the QA plan is never discounted
    return CAMPAIGNS[campaign].prices[tier.id]?.[cycle];
  }
  if (cycle === "test") return tier.monthlyPrice;
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

// Retired prices, kept only so subscribers still on an old plan are labelled
// correctly ("Basic (Monthly)", not "Plan #1"). Never offered for sale —
// PRICING_TIERS above is the only thing the pricing page renders.
const LEGACY_TIER_PRICES: { tierId: string; cycle: "monthly" | "yearly"; price: number }[] = [
  { tierId: "starter", cycle: "monthly", price: 10 },
  { tierId: "basic", cycle: "monthly", price: 29 },
  { tierId: "basic", cycle: "yearly", price: 278.4 },
  { tierId: "advance", cycle: "monthly", price: 69 },
  { tierId: "advance", cycle: "yearly", price: 662.4 },
];

/** Every price a tier has ever been sold at (current + legacy), per cycle. */
const KNOWN_TIER_PRICES = [
  ...PRICING_TIERS.flatMap((t) =>
    (["monthly", "yearly"] as const).flatMap((cycle) => {
      const price = priceForCycle(t, cycle);
      return price === undefined ? [] : [{ tierId: t.id as string, cycle, price }];
    }),
  ),
  ...LEGACY_TIER_PRICES,
];

// Plan ids from the original 5-plan creation order (TIER_PLAN_ID above) —
// only used as a fallback for tokens whose price isn't ~1:1 with USD
// (WETH/WBNB), where price-matching can't work.
const LEGACY_LABEL_BY_PLAN_ID: Record<number, string> = Object.fromEntries(
  Object.entries(TIER_PLAN_ID).map(([key, planId]) => {
    const [tierId, cycle] = key.split(":");
    const tier = PRICING_TIERS.find((t) => t.id === tierId);
    return [planId, `${tier?.name ?? tierId} (${cycle === "monthly" ? "Monthly" : "Yearly"})`];
  }),
);

/**
 * Names the specific tier + cycle a real on-chain plan is ("Basic (Monthly)")
 * rather than just the cycle alone. Used everywhere a subscriber's plan is
 * displayed or recorded (Confirm page, Manage Subscription, the subscribers
 * DB row, the admin panel).
 *
 * Matched by price + billing cycle, not plan id: plan ids are assigned in
 * creation order per chain, so after a re-price the new plans get ids that
 * differ from the original 0-4 and can't be hardcoded.
 */
/** The campaign a plan with this price + cycle belongs to, if any. */
export function campaignForPlanPrice(price: number | string, kind: string): CampaignId | null {
  if (kind !== "monthly" && kind !== "yearly") return null;
  const numericPrice = Number(price);
  for (const campaign of Object.values(CAMPAIGNS)) {
    for (const byCycle of Object.values(campaign.prices)) {
      const campaignPrice = byCycle?.[kind];
      if (campaignPrice !== undefined && Math.abs(campaignPrice - numericPrice) < 0.01) return campaign.id;
    }
  }
  return null;
}

export function tierLabelForPlan(planId: number, price: number | string, kind: string): string | undefined {
  const numericPrice = Number(price);
  if (kind === "monthly" || kind === "yearly") {
    // Partner-discount plans (their prices never equal a normal price).
    for (const campaign of Object.values(CAMPAIGNS)) {
      for (const [tierId, byCycle] of Object.entries(campaign.prices)) {
        const campaignPrice = byCycle?.[kind];
        if (campaignPrice !== undefined && Math.abs(campaignPrice - numericPrice) < 0.01) {
          const name = PRICING_TIERS.find((t) => t.id === tierId)?.name ?? tierId;
          return `${name} (${kind === "monthly" ? "Monthly" : "Yearly"}) · ${campaign.name}`;
        }
      }
    }
    const match = KNOWN_TIER_PRICES.find((k) => k.cycle === kind && Math.abs(k.price - numericPrice) < 0.01);
    if (match) {
      const name = PRICING_TIERS.find((t) => t.id === match.tierId)?.name ?? match.tierId;
      return `${name} (${kind === "monthly" ? "Monthly" : "Yearly"})`;
    }
  }
  // Id fallback (WETH/WBNB-style tokens). Plan ids aren't the same on every
  // chain — e.g. BNB Chain's #1 is a stray $100/yr default plan, not "Basic
  // (Monthly)" — so only trust it when its billing cycle agrees with the
  // plan's real interval.
  const byId = LEGACY_LABEL_BY_PLAN_ID[planId];
  if (byId && (kind === "monthly" || kind === "yearly") && byId.endsWith(kind === "monthly" ? "(Monthly)" : "(Yearly)")) {
    return byId;
  }
  return undefined;
}

// Matches a pricing tier + billing cycle to a real on-chain plan — the
// contract has no concept of "Starter/Basic/Advance" tiers, only a flat
// list of (price, interval) plans created by the owner. Shared by
// PricingTiers.tsx (button enabled/disabled state) and App.tsx
// (re-resolving a tier choice against whichever chain the wallet ends up
// connected to, so switching networks doesn't just discard the selection).
export function findOnChainPlan<P extends { active: boolean; kind: string; price: string; id: number; promo?: unknown }>(
  plans: P[] | null,
  tier: PricingTier,
  cycle: BillingCycle,
  campaign?: CampaignId | null,
): P | undefined {
  const targetPrice = priceForCycle(tier, cycle, campaign);
  if (targetPrice === undefined || !plans) return undefined;
  const kind = cycle === "monthly" ? "monthly" : cycle === "yearly" ? "yearly" : "test";

  // Campaign plans are matched by their fixed price AND must carry on-chain
  // promo config (successor + periods): without it the contract would keep
  // charging the discounted price forever, so such a plan is never offered.
  // No creation-order fallback either — promo plan ids aren't predictable.
  if (campaign) {
    return plans.find(
      (p) => p.active && p.kind === kind && p.promo !== undefined && Math.abs(Number(p.price) - targetPrice) < 0.01,
    );
  }

  const byPrice = plans.find((p) => p.active && p.kind === kind && Math.abs(Number(p.price) - targetPrice) < 0.01);
  if (byPrice) return byPrice;

  // No stablecoin-range Starter-monthly plan (any price it has ever had)
  // anywhere in this list means this token's price-matching can never work
  // (WETH/WBNB territory) — fall back to the fixed creation-order id. A real
  // stablecoin chain always has a Starter-monthly plan at one of those
  // prices, so this branch never triggers for USDC/USDT and can't
  // accidentally mismatch a plan there.
  const starterPrices = KNOWN_TIER_PRICES.filter((k) => k.tierId === "starter" && k.cycle === "monthly").map((k) => k.price);
  const looksLikeStablecoin = plans.some(
    (p) => p.kind === "monthly" && starterPrices.some((price) => Math.abs(Number(p.price) - price) < 0.01),
  );
  if (looksLikeStablecoin) return undefined;

  const expectedId = TIER_PLAN_ID[`${tier.id}:${cycle}`];
  if (expectedId === undefined) return undefined;
  return plans.find((p) => p.active && p.kind === kind && p.id === expectedId);
}
