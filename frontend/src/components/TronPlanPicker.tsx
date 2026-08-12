import { useEffect, useState } from "react";
import { fetchTronPlans, formatDuration, type TronPlanInfo } from "../lib/tronPlans";
import { isTronConfigured, IS_TRON_MAINNET_MODE } from "../lib/tronContracts";

type TronPlanPickerProps = {
  refreshKey: number;
  onSelect: (plan: TronPlanInfo) => void;
};

export function TronPlanPicker({ refreshKey, onSelect }: TronPlanPickerProps) {
  const [plans, setPlans] = useState<TronPlanInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deployed = isTronConfigured();

  useEffect(() => {
    setPlans(null);
    setError(null);
    if (!deployed) return;
    let cancelled = false;
    fetchTronPlans()
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

  const monthly = plans?.find((p) => p.active && p.kind === "monthly");
  const yearly = plans?.find((p) => p.active && p.kind === "yearly");
  const test = plans?.find((p) => p.active && p.kind === "test");
  const other = plans?.filter((p) => p.active && p.kind === "other") ?? [];

  return (
    <section className="checkout-step">
      <h2>Choose your plan</h2>
      <p className="muted">Pay in USDT on TRON {IS_TRON_MAINNET_MODE ? "Mainnet" : "Nile testnet"}. Cancel anytime.</p>

      {!deployed && <p className="muted">Not deployed on TRON {IS_TRON_MAINNET_MODE ? "Mainnet" : "Nile"} yet.</p>}
      {error && <p className="error">{error}</p>}
      {deployed && !plans && !error && <p className="muted">Loading plans...</p>}

      {plans && !monthly && !yearly && !test && other.length === 0 && (
        <p className="muted">No plans are available yet. Please check back soon.</p>
      )}

      <div className="plan-grid">
        {monthly && (
          <div className="plan-card">
            <span className="plan-card__badge">Monthly</span>
            <div className="plan-card__price">
              {monthly.price} <span>USDT / month</span>
            </div>
            <p className="muted">Billed every {monthly.intervalDays} days</p>
            <button onClick={() => onSelect(monthly)}>Subscribe Monthly</button>
          </div>
        )}
        {yearly && (
          <div className="plan-card plan-card--highlight">
            <span className="plan-card__badge">Yearly</span>
            <div className="plan-card__price">
              {yearly.price} <span>USDT / year</span>
            </div>
            <p className="muted">Billed every {yearly.intervalDays} days</p>
            <button onClick={() => onSelect(yearly)}>Subscribe Yearly</button>
          </div>
        )}
        {test && (
          <div className="plan-card">
            <span className="plan-card__badge">Test</span>
            <div className="plan-card__price">
              {test.price} <span>USDT / {formatDuration(test.intervalSeconds)}</span>
            </div>
            <p className="muted">Billed every {formatDuration(test.intervalSeconds)} — for testing renewals</p>
            <button onClick={() => onSelect(test)}>Subscribe (Test)</button>
          </div>
        )}
        {other.map((plan) => (
          <div className="plan-card" key={plan.id}>
            <span className="plan-card__badge">Plan #{plan.id}</span>
            <div className="plan-card__price">
              {plan.price} <span>USDT / {formatDuration(plan.intervalSeconds)}</span>
            </div>
            <button onClick={() => onSelect(plan)}>Subscribe</button>
          </div>
        ))}
      </div>
    </section>
  );
}
