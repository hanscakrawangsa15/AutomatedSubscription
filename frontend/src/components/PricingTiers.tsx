import { useEffect, useState } from "react";
import { fetchPlans, type PlanInfo } from "../lib/plans";
import { getReadProvider } from "../lib/readProvider";
import {
  PRICING_TIERS,
  TEST_TIER,
  priceForCycle,
  findOnChainPlan,
  type BillingCycle,
  type PricingTier,
} from "../lib/pricingTiers";

// USDT-only, single reference chain — every price shown here is identical
// in USDT no matter which network the user ends up paying from (both
// Ethereum's and BNB Chain's USDT managers were created from the exact same
// 5-tier + test plan set — see scripts/create-plans-safe.js /
// create-test-plan-safe.js), so plan availability only needs checking
// against ONE canonical deployment. The actual payment network (ERC-20 on
// Ethereum vs BEP-20 on BNB Chain) is chosen afterward, on the Confirm step
// — see App.tsx's PaymentNetworkStep.
const REFERENCE_CHAIN_ID = 1; // Ethereum Mainnet
const REFERENCE_SUFFIX = "_USDT";

type PricingTiersProps = {
  refreshKey: number;
  // Passes the tier/cycle alongside the resolved (reference-chain) plan —
  // App.tsx only uses tierId/cycle from this to re-resolve against whichever
  // network the user picks on the next step, not the plan object itself.
  onSelect: (plan: PlanInfo, tierId: PricingTier["id"], cycle: BillingCycle) => void;
};

export function PricingTiers({ refreshKey, onSelect }: PricingTiersProps) {
  const [plans, setPlans] = useState<PlanInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cycle, setCycle] = useState<BillingCycle>("monthly");

  useEffect(() => {
    setPlans(null);
    setError(null);
    const provider = getReadProvider(REFERENCE_CHAIN_ID);
    if (!provider) {
      setError(`No RPC configured for chain ${REFERENCE_CHAIN_ID}`);
      return;
    }
    let cancelled = false;
    fetchPlans(provider, REFERENCE_CHAIN_ID, REFERENCE_SUFFIX)
      .then((loaded) => {
        if (!cancelled) setPlans(loaded);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load plans");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const visibleTiers = PRICING_TIERS.filter((t) => priceForCycle(t, cycle) !== undefined);
  const testPlan = findOnChainPlan(plans, TEST_TIER, "test");

  return (
    <section className="checkout-step pricing-tiers">
      <h2 className="pricing-tiers__title">Give your trading an edge beyond manual clicks 🏦</h2>
      <p className="muted pricing-tiers__subtitle">
        Select a plan that lets advanced bots work alongside your manual trading — tightening your risk control,
        reducing mistakes, and keeping your strategy running even when you're away.
      </p>
      <p className="muted" style={{ textAlign: "center" }}>
        Pay in USDT — choose Ethereum or BNB Chain on the next step. Cancel anytime.
      </p>

      {error && (
        <p className="error" style={{ textAlign: "center" }}>
          {error}
        </p>
      )}

      <div className="billing-toggle">
        <button className={cycle === "monthly" ? "active" : ""} onClick={() => setCycle("monthly")}>
          Pay Monthly
        </button>
        <button className={cycle === "yearly" ? "active" : ""} onClick={() => setCycle("yearly")}>
          Pay Annually <span className="billing-toggle__badge">20% OFF</span>
        </button>
      </div>

      <div className="pricing-grid">
        {visibleTiers.map((tier) => {
          const price = priceForCycle(tier, cycle)!;
          const onChainPlan = findOnChainPlan(plans, tier, cycle);
          const loading = !plans && !error;
          return (
            <div key={tier.id} className={`pricing-card ${tier.bestDeal ? "pricing-card--best-deal" : ""}`}>
              {tier.bestDeal && <div className="pricing-card__ribbon">🏷️ BEST DEAL</div>}
              <div className="pricing-card__header">
                <h3>
                  {tier.name} ({cycle})
                </h3>
                <span className="pricing-card__icon">{tier.icon}</span>
              </div>
              <div className="pricing-card__price">
                ${price.toFixed(2)}
                <span>/{cycle === "monthly" ? "month" : "year"}</span>
              </div>
              <button
                disabled={!onChainPlan}
                onClick={() => onChainPlan && onSelect(onChainPlan, tier.id, cycle)}
                title={!onChainPlan && !loading ? "This plan isn't live on-chain yet" : undefined}
              >
                {loading ? "Loading..." : onChainPlan ? "Get Started" : "Coming soon"}
              </button>
              <p className="pricing-card__features-label">With this plan, you can run up to:</p>
              <ul className="pricing-card__features">
                {tier.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {testPlan && (
        <div className="test-plan-card">
          <span className="test-plan-card__icon">{TEST_TIER.icon}</span>
          <div className="test-plan-card__body">
            <strong>Test Plan</strong>
            <span className="muted">
              {testPlan.price} {testPlan.tokenSymbol} · charges hourly — internal QA only
            </span>
          </div>
          <button onClick={() => onSelect(testPlan, TEST_TIER.id, "test")}>Get Started</button>
        </div>
      )}

      <p className="muted pricing-tiers__footer">
        Need Help? Contact <a href="mailto:support@xenorize.com">support@xenorize.com</a>
      </p>
    </section>
  );
}
