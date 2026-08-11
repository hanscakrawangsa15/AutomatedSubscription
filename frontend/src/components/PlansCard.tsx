import { useCallback, useEffect, useState } from "react";
import { formatUnits, parseUnits, type JsonRpcSigner } from "ethers";
import { getSubscriptionManager, getMockUsdc } from "../lib/contracts";
import { useTxStatus } from "../hooks/useTxStatus";

type Plan = {
  id: number;
  price: string;
  intervalDays: number;
  graceDays: number;
  active: boolean;
};

type PlansCardProps = {
  signer: JsonRpcSigner;
  account: string;
  chainId: number | bigint;
  isOwner: boolean;
  refreshKey: number;
  onChanged: () => void;
};

export function PlansCard({ signer, account, chainId, isOwner, refreshKey, onChanged }: PlansCardProps) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [newPrice, setNewPrice] = useState("10");
  const [newIntervalDays, setNewIntervalDays] = useState("30");
  const [newGraceDays, setNewGraceDays] = useState("5");
  const { status, run } = useTxStatus();
  const { run: runSubscribe, status: subscribeStatus } = useTxStatus();
  const [subscribingPlan, setSubscribingPlan] = useState<number | null>(null);

  const load = useCallback(async () => {
    const manager = getSubscriptionManager(signer, chainId);
    const usdc = getMockUsdc(signer, chainId);
    const [count, decimals] = await Promise.all([manager.planCount(), usdc.decimals()]);
    const loaded: Plan[] = [];
    for (let i = 0; i < Number(count); i++) {
      const p = await manager.plans(i);
      loaded.push({
        id: i,
        price: formatUnits(p.price, decimals),
        intervalDays: Number(p.interval) / 86400,
        graceDays: Number(p.gracePeriod) / 86400,
        active: p.active,
      });
    }
    setPlans(loaded);
  }, [signer, chainId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const createPlan = () =>
    run(async () => {
      const manager = getSubscriptionManager(signer, chainId);
      const usdc = getMockUsdc(signer, chainId);
      const decimals = await usdc.decimals();
      const tx = await manager.createPlan(
        parseUnits(newPrice || "0", decimals),
        Number(newIntervalDays) * 86400,
        Number(newGraceDays) * 86400,
      );
      await tx.wait();
      await load();
      onChanged();
    });

  const togglePlan = (planId: number, active: boolean) =>
    run(async () => {
      const manager = getSubscriptionManager(signer, chainId);
      const tx = await manager.setPlanActive(planId, active);
      await tx.wait();
      await load();
      onChanged();
    });

  const subscribe = (planId: number) => {
    setSubscribingPlan(planId);
    return runSubscribe(async () => {
      const manager = getSubscriptionManager(signer, chainId);
      const tx = await manager.subscribe(planId);
      await tx.wait();
      onChanged();
    });
  };

  return (
    <section className="card">
      <h2>Plans</h2>
      {plans.length === 0 && <p>No plans yet.</p>}
      <table className="plans-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Price (USDC)</th>
            <th>Interval</th>
            <th>Grace</th>
            <th>Active</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {plans.map((plan) => (
            <tr key={plan.id}>
              <td>{plan.id}</td>
              <td>{plan.price}</td>
              <td>{plan.intervalDays}d</td>
              <td>{plan.graceDays}d</td>
              <td>{plan.active ? "Yes" : "No"}</td>
              <td>
                <button
                  disabled={!plan.active || (subscribeStatus === "pending" && subscribingPlan === plan.id)}
                  onClick={() => subscribe(plan.id)}
                >
                  Subscribe
                </button>
                {isOwner && (
                  <button onClick={() => togglePlan(plan.id, !plan.active)} disabled={status === "pending"}>
                    {plan.active ? "Deactivate" : "Activate"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {isOwner && (
        <div className="admin-box">
          <h3>Create Plan (owner only, connected as {account.slice(0, 6)}...)</h3>
          <div className="row">
            <input value={newPrice} onChange={(e) => setNewPrice(e.target.value)} placeholder="Price (USDC)" />
            <input
              value={newIntervalDays}
              onChange={(e) => setNewIntervalDays(e.target.value)}
              placeholder="Interval (days)"
            />
            <input
              value={newGraceDays}
              onChange={(e) => setNewGraceDays(e.target.value)}
              placeholder="Grace period (days)"
            />
            <button onClick={createPlan} disabled={status === "pending"}>
              Create Plan
            </button>
          </div>
        </div>
      )}
      {status === "error" && <p className="error">Transaction failed. See console for details.</p>}
    </section>
  );
}
