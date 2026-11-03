import { useEffect, useState } from "react";
import { fetchPlans, type PlanInfo } from "../lib/plans";
import { getReadProvider } from "../lib/readProvider";
import { PAYMENT_SUFFIX } from "../lib/chains";
import {
  CAMPAIGNS,
  PRICING_TIERS,
  priceForCycle,
  findOnChainPlan,
  type BillingCycle,
  type CampaignId,
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
// Partner-discount plans live on the v2 manager, which BNB Chain gets first
// (docs/bnb-v2-rollout.md), so the /tokocrypto page checks availability there.
const CAMPAIGN_REFERENCE_CHAIN_ID = 56;

type PricingTiersProps = {
  /** Partner-discount page (/tokocrypto) — shows the campaign's fixed prices. */
  campaign?: CampaignId | null;
  refreshKey: number;
  // Passes the tier/cycle alongside the resolved (reference-chain) plan —
  // App.tsx only uses tierId/cycle from this to re-resolve against whichever
  // network the user picks on the next step, not the plan object itself.
  onSelect: (plan: PlanInfo, tierId: PricingTier["id"], cycle: BillingCycle) => void;
};

export function PricingTiers({ campaign = null, refreshKey, onSelect }: PricingTiersProps) {
  const [plans, setPlans] = useState<PlanInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cycle, setCycle] = useState<BillingCycle>("monthly");

  useEffect(() => {
    setPlans(null);
    setError(null);
    const referenceChainId = campaign ? CAMPAIGN_REFERENCE_CHAIN_ID : REFERENCE_CHAIN_ID;
    const provider = getReadProvider(referenceChainId);
    if (!provider) {
      setError(`No RPC configured for chain ${referenceChainId}`);
      return;
    }
    let cancelled = false;
    fetchPlans(provider, referenceChainId, PAYMENT_SUFFIX[referenceChainId] ?? "", campaign !== null)
      .then((loaded) => {
        if (!cancelled) setPlans(loaded);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load plans");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, campaign]);

  const campaignInfo = campaign ? CAMPAIGNS[campaign] : null;
  const visibleTiers = PRICING_TIERS.filter((t) => priceForCycle(t, cycle, campaign) !== undefined);

  return (
    <section className="checkout-step pricing-tiers">
      {campaignInfo && (
        <p className="pricing-tiers__partner">
          Xenorize × {campaignInfo.name} — exclusive member pricing
        </p>
      )}
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
          Pay Annually {!campaignInfo && <span className="billing-toggle__badge">20% OFF</span>}
        </button>
      </div>

      <div className="pricing-grid">
        {visibleTiers.map((tier) => {
          const price = priceForCycle(tier, cycle, campaign)!;
          const normalPrice = campaign ? priceForCycle(tier, cycle) : undefined;
          const onChainPlan = findOnChainPlan(plans, tier, cycle, campaign);
          const loading = !plans && !error;
          return (
            <div
              key={tier.id}
              className={`pricing-card ${tier.bestDeal ? "pricing-card--best-deal" : ""} ${campaignInfo ? "pricing-card--promo" : ""}`}
            >
              {tier.bestDeal && <div className="pricing-card__ribbon">🏷️ BEST DEAL</div>}
              {campaignInfo && <div className="pricing-card__corner">{campaignInfo.ribbon}</div>}
              <div className="pricing-card__header">
                <h3>
                  {tier.name} ({cycle})
                </h3>
                <span className="pricing-card__icon">{tier.icon}</span>
              </div>
              <div className="pricing-card__price">
                {normalPrice !== undefined && <del className="pricing-card__was">${normalPrice.toFixed(2)}</del>}
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

      {campaignInfo && (
        <p className="muted" style={{ textAlign: "center" }}>
          Monthly plans keep the {campaignInfo.name} price for your first 12 payments; the yearly {campaignInfo.name}{" "}
          price applies to your first year only. After that your plan renews automatically at the regular price.
        </p>
      )}

      <p className="muted pricing-tiers__footer">
        Need Help? Contact <a href="mailto:support@xenorize.com">support@xenorize.com</a>
      </p>
    </section>
  );
}
