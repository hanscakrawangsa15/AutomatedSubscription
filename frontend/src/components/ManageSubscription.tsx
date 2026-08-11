import { useCallback, useEffect, useState } from "react";
import { formatUnits, type JsonRpcSigner } from "ethers";
import { getMockUsdc, getSubscriptionManager } from "../lib/contracts";
import { SUBSCRIPTION_STATUS } from "../abi/SubscriptionManager";
import { classifyInterval, formatDuration } from "../lib/plans";
import { useTxStatus } from "../hooks/useTxStatus";
import { useRenewalLog } from "../hooks/useRenewalLog";

const PLAN_LABELS: Record<string, string> = { monthly: "Monthly", yearly: "Yearly", test: "Test" };

type ManageSubscriptionProps = {
  signer: JsonRpcSigner;
  account: string;
  chainId: number | bigint;
  refreshKey: number;
  onChanged: () => void;
  justSubscribed?: boolean;
};

type SubInfo = {
  planId: number;
  status: number;
  nextChargeAt: number;
  overdueSince: number;
  periodsPaid: number;
  planLabel: string;
  intervalSeconds: number;
};

function formatTimestamp(ts: number) {
  if (ts === 0) return "-";
  return new Date(ts * 1000).toLocaleString();
}

export function ManageSubscription({
  signer,
  account,
  chainId,
  refreshKey,
  onChanged,
  justSubscribed,
}: ManageSubscriptionProps) {
  const [info, setInfo] = useState<SubInfo | null>(null);
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const { status, run } = useTxStatus();
  const renewalLog = useRenewalLog(account, chainId);

  const load = useCallback(async () => {
    const manager = getSubscriptionManager(signer, chainId);
    const usdc = getMockUsdc(signer, chainId);
    const [sub, balanceRaw, decimals] = await Promise.all([
      manager.subscriptions(account),
      usdc.balanceOf(account),
      usdc.decimals(),
    ]);
    const plan = await manager.plans(sub.planId);
    const intervalSeconds = Number(plan.interval);
    const kind = classifyInterval(intervalSeconds / 86400);
    setInfo({
      planId: Number(sub.planId),
      status: Number(sub.status),
      nextChargeAt: Number(sub.nextChargeAt),
      overdueSince: Number(sub.overdueSince),
      periodsPaid: Number(sub.periodsPaid),
      planLabel: PLAN_LABELS[kind] ?? `Plan #${sub.planId}`,
      intervalSeconds,
    });
    setWalletBalance(formatUnits(balanceRaw, decimals));
  }, [signer, account, chainId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Keep the balance current as renewals happen live in the background, not
  // just after the user's own actions (which is all `refreshKey` covers).
  useEffect(() => {
    if (renewalLog.length > 0) void load();
  }, [renewalLog, load]);

  const cancel = () =>
    run(async () => {
      const manager = getSubscriptionManager(signer, chainId);
      const tx = await manager.cancel();
      await tx.wait();
      await load();
      onChanged();
    });

  const payNow = () =>
    run(async () => {
      const manager = getSubscriptionManager(signer, chainId);
      const tx = await manager.payNow();
      await tx.wait();
      await load();
      onChanged();
    });

  const retryCharge = () =>
    run(async () => {
      const manager = getSubscriptionManager(signer, chainId);
      const tx = await manager.retryCharge(account);
      await tx.wait();
      await load();
      onChanged();
    });

  if (!info) return <p className="muted">Loading your subscription...</p>;

  const statusLabel = SUBSCRIPTION_STATUS[info.status] ?? "Unknown";

  return (
    <section className="checkout-step">
      {justSubscribed && (
        <div className="banner banner--success">
          You're subscribed! Your {info.planLabel.toLowerCase()} plan is now active.
        </div>
      )}

      <h2>Your subscription</h2>

      <div className="summary-card">
        <div className="summary-row">
          <span>Wallet balance</span>
          <strong>{walletBalance !== null ? `${walletBalance} USDC` : "..."}</strong>
        </div>
        <div className="summary-row">
          <span>Status</span>
          <span className={`status-pill status-pill--${statusLabel.toLowerCase()}`}>{statusLabel}</span>
        </div>
        <div className="summary-row">
          <span>Plan</span>
          <strong>{info.planLabel}</strong>
        </div>
        <div className="summary-row">
          <span>Next charge</span>
          <strong>{formatTimestamp(info.nextChargeAt)}</strong>
        </div>
        <div className="summary-row">
          <span>Periods paid</span>
          <strong>{info.periodsPaid}</strong>
        </div>
        {statusLabel === "Overdue" && (
          <div className="summary-row">
            <span>Overdue since</span>
            <strong>{formatTimestamp(info.overdueSince)}</strong>
          </div>
        )}
      </div>

      {statusLabel === "Overdue" && (
        <p className="error">
          Your last charge failed (insufficient balance or allowance). Pay now to stay active before the
          grace period ends.
        </p>
      )}

      <p className="muted">
        Renewals are charged automatically every {formatDuration(info.intervalSeconds)} by an off-chain keeper (bot/cron/
        Chainlink Automation) calling the contract — make sure your wallet keeps enough USDC balance and
        allowance.
      </p>

      {renewalLog.length > 0 && (
        <div className="activity-log">
          <h3>Renewal activity</h3>
          <ul>
            {renewalLog.map((entry) => (
              <li key={entry.key}>
                <span>{new Date(entry.timestamp * 1000).toLocaleString()}</span>
                <span>Charged {entry.amount} USDC</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="row">
        {(statusLabel === "Active" || statusLabel === "Overdue") && (
          <button onClick={cancel} disabled={status === "pending"} className="secondary">
            Cancel Subscription
          </button>
        )}
        {statusLabel === "Overdue" && (
          <>
            <button onClick={payNow} disabled={status === "pending"}>
              Pay Now
            </button>
            <button onClick={retryCharge} disabled={status === "pending"}>
              Retry Charge
            </button>
          </>
        )}
      </div>

      {status === "error" && <p className="error">Transaction failed. See console for details.</p>}
    </section>
  );
}
