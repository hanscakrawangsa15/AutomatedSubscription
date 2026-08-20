import { useCallback, useEffect, useState } from "react";
import { type JsonRpcSigner } from "ethers";
import { getMockUsdc, getSubscriptionManager } from "../lib/contracts";
import { SUBSCRIPTION_STATUS } from "../abi/SubscriptionManager";
import { classifyInterval, formatDuration } from "../lib/plans";
import { useTxStatus } from "../hooks/useTxStatus";
import { useRenewalLog } from "../hooks/useRenewalLog";
import { reportSubscription } from "../lib/notify";
import { getChainSlug, getChainName } from "../lib/chains";
import { waitForTx } from "../lib/waitForTx";
import { tierLabelForPlanId } from "../lib/pricingTiers";

const PLAN_LABELS: Record<string, string> = { monthly: "Monthly", yearly: "Yearly", test: "Test" };

type ManageSubscriptionProps = {
  signer: JsonRpcSigner;
  account: string;
  chainId: number | bigint;
  // "" = the chain's primary/default payment method. See App.tsx's
  // subscription-discovery effect, which resolves this by checking every
  // configured manager for an Active/Overdue subscription.
  tokenSuffix: string;
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
  tokenSymbol: string;
};

function formatTimestamp(ts: number) {
  if (ts === 0) return "-";
  return new Date(ts * 1000).toLocaleString();
}

export function ManageSubscription({
  signer,
  account,
  chainId,
  tokenSuffix,
  refreshKey,
  onChanged,
  justSubscribed,
}: ManageSubscriptionProps) {
  const [info, setInfo] = useState<SubInfo | null>(null);
  const { status, errorMessage, run } = useTxStatus();
  const renewalLog = useRenewalLog(account, chainId, tokenSuffix);

  const load = useCallback(async () => {
    const manager = getSubscriptionManager(signer, chainId, tokenSuffix);
    const usdc = getMockUsdc(signer, chainId, tokenSuffix);
    const [sub, symbol] = await Promise.all([manager.subscriptions(account), usdc.symbol()]);
    const plan = await manager.plans(sub.planId);
    const intervalSeconds = Number(plan.interval);
    const kind = classifyInterval(intervalSeconds / 86400);
    setInfo({
      planId: Number(sub.planId),
      status: Number(sub.status),
      nextChargeAt: Number(sub.nextChargeAt),
      overdueSince: Number(sub.overdueSince),
      periodsPaid: Number(sub.periodsPaid),
      planLabel: tierLabelForPlanId(Number(sub.planId)) ?? PLAN_LABELS[kind] ?? `Plan #${sub.planId}`,
      intervalSeconds,
      tokenSymbol: symbol,
    });
  }, [signer, account, chainId, tokenSuffix]);

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
      // The Cancel button only renders once `info` has loaded (see the
      // early-return below), so this is always non-null in practice — the
      // guard just satisfies the type checker without an unsafe assertion.
      const currentInfo = info;
      const manager = getSubscriptionManager(signer, chainId, tokenSuffix);
      const tx = await manager.cancel();
      await waitForTx(tx, chainId);
      // periodsPaid/nextChargeAt/renewalResult omitted on purpose — cancel()
      // doesn't touch them on-chain, and the server preserves whatever was
      // already stored for fields it isn't given.
      if (currentInfo) {
        await reportSubscription({
          address: account,
          chainName: getChainSlug(chainId),
          chainId: Number(chainId),
          planId: currentInfo.planId,
          planLabel: currentInfo.planLabel,
          txHash: tx.hash,
          status: "inactive",
        }).catch(() => {});
      }
      await load();
      onChanged();
    }, "Cancel Subscription");

  // Both payNow() and retryCharge() advance the contract's lifetime
  // periodsPaid/nextChargeAt fields just like a keeper-triggered renewal
  // does — synced to the subscribers table the same way so the admin
  // panel stays accurate regardless of which path produced the charge.
  // Best-effort: a failed sync here never blocks the tx itself, which has
  // already gone through by this point. Unlike the keeper's chargeDue path,
  // both of these contract functions revert outright on insufficient
  // allowance/balance rather than silently degrading — reaching this line
  // always means the charge genuinely succeeded.
  const syncRenewalInfo = async (manager: ReturnType<typeof getSubscriptionManager>, txHash: string) => {
    const sub = await manager.subscriptions(account);
    const plan = await manager.plans(sub.planId);
    const kind = classifyInterval(Number(plan.interval) / 86400);
    await reportSubscription({
      address: account,
      chainName: getChainSlug(chainId),
      chainId: Number(chainId),
      planId: Number(sub.planId),
      planLabel: tierLabelForPlanId(Number(sub.planId)) ?? PLAN_LABELS[kind] ?? kind,
      txHash,
      periodsPaid: Number(sub.periodsPaid),
      nextChargeAt: Number(sub.nextChargeAt),
      status: "active",
      renewalResult: "success",
    }).catch(() => {});
  };

  const payNow = () =>
    run(async () => {
      const manager = getSubscriptionManager(signer, chainId, tokenSuffix);
      const tx = await manager.payNow();
      await waitForTx(tx, chainId);
      await syncRenewalInfo(manager, tx.hash);
      await load();
      onChanged();
    }, "Pay Now");

  const retryCharge = () =>
    run(async () => {
      const manager = getSubscriptionManager(signer, chainId, tokenSuffix);
      const tx = await manager.retryCharge(account);
      await waitForTx(tx, chainId);
      await syncRenewalInfo(manager, tx.hash);
      await load();
      onChanged();
    }, "Retry Charge");

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
        <div className="summary-row">
          <span>Paid by</span>
          <strong>{getChainName(chainId)}</strong>
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
        Chainlink Automation) calling the contract — make sure your wallet keeps enough {info.tokenSymbol} balance
        and allowance.
      </p>

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

      {status === "error" && <p className="error">{errorMessage ?? "Transaction failed. See console for details."}</p>}
    </section>
  );
}
