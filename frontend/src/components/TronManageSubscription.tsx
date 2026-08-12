import { useCallback, useEffect, useState } from "react";
import { getTronSubscriptionManager, getTronUsdc, IS_TRON_MAINNET_MODE } from "../lib/tronContracts";
import { SUBSCRIPTION_STATUS_TRON } from "../abi/SubscriptionManagerTron";
import { classifyInterval, formatDuration } from "../lib/plans";
import { formatTxError } from "../lib/errors";
import { useTronRenewalLog } from "../hooks/useTronRenewalLog";

const PLAN_LABELS: Record<string, string> = { monthly: "Monthly", yearly: "Yearly", test: "Test" };
const FEE_LIMIT = 150_000_000;

type TronManageSubscriptionProps = {
  account: string;
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

export function TronManageSubscription({ account, refreshKey, onChanged, justSubscribed }: TronManageSubscriptionProps) {
  const [info, setInfo] = useState<SubInfo | null>(null);
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "pending" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const renewalLog = useTronRenewalLog(account);

  const load = useCallback(async () => {
    // getTronSubscriptionManager()/getTronUsdc() can throw synchronously
    // (e.g. TronLink connected but on the wrong network). A throw here
    // becomes a rejected promise (this is an async function), which is
    // safe against crashing the tree, but it'd be silently swallowed by
    // the `void load()` call sites without this catch — surface it instead.
    try {
      const manager = getTronSubscriptionManager();
      const usdc = getTronUsdc();
      const [sub, balanceRaw, decimals] = await Promise.all([
        manager.subscriptions(account).call(),
        usdc.balanceOf(account).call(),
        usdc.decimals().call(),
      ]);
      const plan = await manager.plans(sub.planId).call();
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
      const divisor = 10n ** BigInt(decimals);
      const raw = BigInt(balanceRaw);
      setWalletBalance(`${raw / divisor}.${(raw % divisor).toString().padStart(Number(decimals), "0")}`.replace(/0+$/, "").replace(/\.$/, ""));
    } catch (err) {
      setErrorMsg(formatTxError(err));
    }
  }, [account]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (renewalLog.length > 0) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renewalLog]);

  const run = async (action: () => Promise<unknown>) => {
    setStatus("pending");
    setErrorMsg(null);
    try {
      await action();
      await load();
      onChanged();
      setStatus("idle");
    } catch (err) {
      setErrorMsg(formatTxError(err));
      setStatus("error");
    }
  };

  const cancel = () =>
    run(() => getTronSubscriptionManager().cancel().send({ feeLimit: FEE_LIMIT, shouldPollResponse: true }));

  const payNow = () =>
    run(() => getTronSubscriptionManager().payNow().send({ feeLimit: FEE_LIMIT, shouldPollResponse: true }));

  const retryCharge = () =>
    run(() =>
      getTronSubscriptionManager().retryCharge(account).send({ feeLimit: FEE_LIMIT, shouldPollResponse: true }),
    );

  if (!info) return <p className="muted">Loading your subscription...</p>;

  const statusLabel = SUBSCRIPTION_STATUS_TRON[info.status] ?? "Unknown";

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
          <strong>{walletBalance !== null ? `${walletBalance} USDT` : "..."}</strong>
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
        Renewals are charged automatically every {formatDuration(info.intervalSeconds)} by an off-chain
        keeper (scripts/keeper.tron.js) calling the contract — make sure your wallet keeps enough USDT
        balance and allowance.
      </p>

      {renewalLog.length > 0 && (
        <div className="activity-log">
          <h3>Renewal activity</h3>
          <ul>
            {renewalLog.map((entry) => (
              <li key={entry.key}>
                <span>{new Date(entry.timestamp * 1000).toLocaleString()}</span>
                <span>Charged {entry.amount} USDT</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {status === "pending" && (
        <p className="muted">
          Check TronLink for a confirmation popup. {IS_TRON_MAINNET_MODE ? "This" : "Nile testnet"} can take up to a
          minute to confirm.
        </p>
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

      {errorMsg && <p className="error">{errorMsg}</p>}
    </section>
  );
}
