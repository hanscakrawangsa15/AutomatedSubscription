import { useEffect, useState } from "react";
import { fetchSolanaPlans, type SolanaPlanInfo } from "../lib/solanaPlans";
import { isSolanaConfigured, IS_SOLANA_MAINNET_MODE } from "../lib/solanaProgram";
import { PRICING_TIERS, priceForCycle, findOnChainPlan, type BillingCycle } from "../lib/pricingTiers";

// Reuses the same 5-tier pricing structure as the EVM tab (PricingTiers.tsx)
// since the program was seeded with the exact same plan set — a generic
// `plans.find(kind === "monthly")` would only ever surface one of Starter/
// Basic/Advance's monthly plans and silently hide the other two. No
// per-chain token selector here (unlike PricingTiers.tsx's EVM version) —
// this pilot has exactly one Config/token on Solana.
type SolanaPlanPickerProps = {
  refreshKey: number;
  onSelect: (plan: SolanaPlanInfo) => void;
};

export function SolanaPlanPicker({ refreshKey, onSelect }: SolanaPlanPickerProps) {
  const [plans, setPlans] = useState<SolanaPlanInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const deployed = isSolanaConfigured();

  useEffect(() => {
    setPlans(null);
    setError(null);
    if (!deployed) return;
    let cancelled = false;
    fetchSolanaPlans()
      .then((loaded) => {
        if (!cancelled) setPlans(loaded);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load plans");
      });
    return () => {
      cancelled = true;
    };
  }, [deployed, refreshKey]);

  const visibleTiers = PRICING_TIERS.filter((t) => priceForCycle(t, cycle) !== undefined);
  const loading = deployed && !plans && !error;

  return (
    <section className="checkout-step pricing-tiers">
      <h2 className="pricing-tiers__title">Give your trading an edge beyond manual clicks 🏦</h2>
      <p className="muted" style={{ textAlign: "center" }}>
        Pay in USDT on Solana {IS_SOLANA_MAINNET_MODE ? "Mainnet" : "Devnet"}. Cancel anytime.
      </p>

      {!deployed && (
        <p className="muted" style={{ textAlign: "center" }}>
          Not deployed on Solana {IS_SOLANA_MAINNET_MODE ? "Mainnet" : "Devnet"} yet.
        </p>
      )}
      {error && <p className="error" style={{ textAlign: "center" }}>{error}</p>}

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
                onClick={() => onChainPlan && onSelect(onChainPlan)}
                title={!onChainPlan && !loading ? "This plan isn't live on-chain on this network yet" : undefined}
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

      <p className="muted pricing-tiers__footer">
        Need Help? Contact <a href="mailto:support@xenorize.com">support@xenorize.com</a>
      </p>
    </section>
  );
}
