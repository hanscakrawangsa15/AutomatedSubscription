import { useEffect, useState } from "react";
import { fetchPlans, sleep, type PlanInfo } from "../lib/plans";
import { getReadProvider } from "../lib/readProvider";
import { getChainName } from "../lib/chains";
import { getPaymentMethods } from "../lib/contracts";
import {
  PRICING_TIERS,
  TEST_TIER,
  priceForCycle,
  findOnChainPlan,
  type BillingCycle,
  type PricingTier,
} from "../lib/pricingTiers";

type PricingTiersProps = {
  chainId: number | bigint;
  refreshKey: number;
  // Passes the tier/cycle alongside the resolved on-chain plan (not just
  // the plan alone) so the caller can re-resolve the same tier choice if
  // the connected chain changes later — see App.tsx's re-resolution effect.
  onSelect: (plan: PlanInfo, tierId: PricingTier["id"], cycle: BillingCycle) => void;
};

export function PricingTiers({ chainId, refreshKey, onSelect }: PricingTiersProps) {
  const methods = getPaymentMethods(chainId);
  const deployed = methods.length > 0;

  // Keyed by token suffix ("" = primary) so the token-selector pills can
  // show a live symbol/loading state for every method, not just whichever
  // one is currently selected.
  const [plansBySuffix, setPlansBySuffix] = useState<Record<string, PlanInfo[]>>({});
  const [errorsBySuffix, setErrorsBySuffix] = useState<Record<string, string>>({});
  const [selectedSuffix, setSelectedSuffix] = useState("");
  const [cycle, setCycle] = useState<BillingCycle>("monthly");

  useEffect(() => {
    setPlansBySuffix({});
    setErrorsBySuffix({});
    setSelectedSuffix("");
    if (!deployed) return;
    const provider = getReadProvider(chainId);
    if (!provider) {
      setErrorsBySuffix({ "": `No RPC configured for chain ${chainId}` });
      return;
    }
    let cancelled = false;
    // Re-derived here (rather than closing over the outer `methods`) so
    // this effect's dependency array can name every value it actually
    // reads — getPaymentMethods() is cheap, memoized per chainId in
    // contracts.ts.
    //
    // Staggered (not all fired at once): every method's fetch does several
    // RPC calls internally, so N methods loading in the same instant can
    // burst well past a free-tier RPC key's per-second limit right at
    // mount — a stagger spreads that burst out without slowing down the
    // typical 1-2 method case noticeably.
    getPaymentMethods(chainId).forEach((method, index) => {
      sleep(index * 250)
        .then(() => (cancelled ? null : fetchPlans(provider, chainId, method.suffix)))
        .then((loaded) => {
          if (cancelled || !loaded) return;
          setPlansBySuffix((prev) => ({ ...prev, [method.suffix]: loaded }));
        })
        .catch((err) => {
          if (cancelled) return;
          setErrorsBySuffix((prev) => ({
            ...prev,
            [method.suffix]: err instanceof Error ? err.message : "Failed to load plans",
          }));
        });
    });
    return () => {
      cancelled = true;
    };
  }, [chainId, deployed, refreshKey]);

  const plans = plansBySuffix[selectedSuffix] ?? null;
  const error = errorsBySuffix[selectedSuffix];
  const visibleTiers = PRICING_TIERS.filter((t) => priceForCycle(t, cycle) !== undefined);
  const selectedSymbol = plans?.[0]?.tokenSymbol;
  const testPlan = findOnChainPlan(plans, TEST_TIER, "test");

  return (
    <section className="checkout-step pricing-tiers">
      <h2 className="pricing-tiers__title">Give your trading an edge beyond manual clicks 🏦</h2>
      <p className="muted pricing-tiers__subtitle">
        Select a plan that lets advanced bots work alongside your manual trading — tightening your risk control,
        reducing mistakes, and keeping your strategy running even when you're away.
      </p>
      <p className="muted" style={{ textAlign: "center" }}>
        Pay in {selectedSymbol ?? "USDC/USDT"} on {getChainName(chainId)}. Cancel anytime.
      </p>

      {!deployed && <p className="muted" style={{ textAlign: "center" }}>Not deployed on {getChainName(chainId)} yet.</p>}
      {error && <p className="error" style={{ textAlign: "center" }}>{error}</p>}

      {methods.length > 1 && (
        <div className="billing-toggle">
          {methods.map((m) => {
            const symbol = plansBySuffix[m.suffix]?.[0]?.tokenSymbol ?? (m.suffix.replace(/^_/, "") || "Default");
            return (
              <button
                key={m.suffix}
                className={selectedSuffix === m.suffix ? "active" : ""}
                onClick={() => setSelectedSuffix(m.suffix)}
              >
                Pay with {symbol}
              </button>
            );
          })}
        </div>
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
          const loading = deployed && !plans && !error;
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
