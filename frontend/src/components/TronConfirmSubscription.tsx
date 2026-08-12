import { useEffect, useState } from "react";
import {
  getTronUsdc,
  getTronSubscriptionManager,
  getTronAddresses,
  switchToTronNetwork,
  IS_TRON_MAINNET_MODE,
} from "../lib/tronContracts";
import { formatTxError } from "../lib/errors";
import { formatDuration, type TronPlanInfo } from "../lib/tronPlans";
import { EMAIL_RE, registerNotificationEmail } from "../lib/notify";

const PLAN_LABELS: Record<string, string> = { monthly: "Monthly", yearly: "Yearly", test: "Test" };

const PERIODS_TO_APPROVE = 12n;
const FEE_LIMIT = 150_000_000; // 150 TRX cap per contract call, same as scripts/keeper.tron.js

type Step = "checking" | "ready" | "approving" | "subscribing" | "error";

type TronConfirmSubscriptionProps = {
  account: string;
  plan: TronPlanInfo;
  onBack: () => void;
  onSubscribed: () => void;
};

export function TronConfirmSubscription({ account, plan, onBack, onSubscribed }: TronConfirmSubscriptionProps) {
  const [step, setStep] = useState<Step>("checking");
  const [needsApproval, setNeedsApproval] = useState<boolean | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [notifyStatus, setNotifyStatus] = useState<"idle" | "sent" | "failed">("idle");
  const [retryKey, setRetryKey] = useState(0);
  const [switching, setSwitching] = useState(false);

  const managerAddress = getTronAddresses()?.manager;
  const wrongNetwork = errorMsg?.includes("Couldn't find the contract on this network") ?? false;

  const handleSwitchNetwork = async () => {
    setSwitching(true);
    try {
      await switchToTronNetwork();
      setStep("checking");
      setErrorMsg(null);
      setRetryKey((k) => k + 1);
    } catch (err) {
      setErrorMsg(formatTxError(err));
    } finally {
      setSwitching(false);
    }
  };

  useEffect(() => {
    if (!managerAddress) {
      setErrorMsg(`SubscriptionManager isn't configured for TRON ${IS_TRON_MAINNET_MODE ? "Mainnet" : "Nile"}.`);
      setStep("error");
      return;
    }
    let cancelled = false;
    // getTronUsdc() can throw synchronously (e.g. TronLink connected but on
    // the wrong network) — wrapped in try/catch since a synchronous throw
    // inside a useEffect isn't caught by a trailing .catch() on the promise
    // chain and would otherwise crash the whole React tree (no error
    // boundary in this app).
    try {
      getTronUsdc()
        .allowance(account, managerAddress)
        .call()
        .then((allowance) => {
          if (cancelled) return;
          setNeedsApproval(BigInt(allowance) < plan.priceRaw);
          setStep("ready");
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setErrorMsg(formatTxError(err));
          setStep("error");
        });
    } catch (err) {
      setErrorMsg(formatTxError(err));
      setStep("error");
    }
    return () => {
      cancelled = true;
    };
  }, [account, managerAddress, plan.priceRaw, retryKey]);

  const confirmAndSubscribe = async () => {
    if (!managerAddress) return;
    setErrorMsg(null);
    try {
      if (needsApproval) {
        setStep("approving");
        const usdc = getTronUsdc();
        await usdc
          .approve(managerAddress, plan.priceRaw * PERIODS_TO_APPROVE)
          .send({ feeLimit: FEE_LIMIT, shouldPollResponse: true });
      }

      setStep("subscribing");
      const manager = getTronSubscriptionManager();
      await manager.subscribe(plan.id).send({ feeLimit: FEE_LIMIT, shouldPollResponse: true });

      if (email && EMAIL_RE.test(email)) {
        const ok = await registerNotificationEmail(account, email);
        setNotifyStatus(ok ? "sent" : "failed");
      }

      onSubscribed();
    } catch (err) {
      setErrorMsg(formatTxError(err));
      setStep("ready");
    }
  };

  const busy = step === "approving" || step === "subscribing";

  return (
    <section className="checkout-step">
      <h2>Confirm your subscription</h2>

      <div className="summary-card">
        <div className="summary-row">
          <span>Plan</span>
          <strong>{PLAN_LABELS[plan.kind] ?? `Plan #${plan.id}`}</strong>
        </div>
        <div className="summary-row">
          <span>Price</span>
          <strong>{plan.price} USDT</strong>
        </div>
        <div className="summary-row">
          <span>Billing interval</span>
          <strong>every {formatDuration(plan.intervalSeconds)}</strong>
        </div>
        <div className="summary-row">
          <span>Wallet</span>
          <strong>
            {account.slice(0, 6)}...{account.slice(-4)}
          </strong>
        </div>
      </div>

      <label className="field-label" htmlFor="tron-notify-email">
        Email for renewal receipts (optional)
      </label>
      <input
        id="tron-notify-email"
        type="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={busy}
      />

      {needsApproval === true && (
        <p className="muted">
          You'll be asked to confirm <strong>twice</strong> in TronLink: first to approve USDT spending
          (covering {PERIODS_TO_APPROVE.toString()} billing cycles, so you won't be asked again for a
          while), then to start your subscription.
        </p>
      )}
      {needsApproval === false && (
        <p className="muted">
          You already approved enough USDT — this only needs <strong>one</strong> wallet confirmation.
        </p>
      )}

      <ol className="step-indicator">
        {needsApproval !== false && (
          <li className={step === "approving" ? "active" : step === "subscribing" ? "done" : ""}>
            Approve USDT spending
          </li>
        )}
        <li className={step === "subscribing" ? "active" : ""}>Confirm subscription</li>
      </ol>

      {busy && (
        <p className="muted">
          Check TronLink for a confirmation popup and approve it there. {IS_TRON_MAINNET_MODE ? "This" : "Nile testnet"}{" "}
          can take up to a minute to confirm — this button will stay on "Confirming..." until it does.
        </p>
      )}

      <div className="row">
        <button onClick={onBack} disabled={busy} className="secondary">
          Back
        </button>
        <button onClick={confirmAndSubscribe} disabled={busy || step === "checking" || step === "error"}>
          {step === "checking" && "Checking..."}
          {step === "approving" && "Approving..."}
          {step === "subscribing" && "Confirming..."}
          {(step === "ready" || step === "error") && "Confirm & Subscribe"}
        </button>
      </div>

      {errorMsg && <p className="error">{errorMsg}</p>}
      {wrongNetwork && (
        <button onClick={handleSwitchNetwork} disabled={switching} className="secondary">
          {switching ? "Switching..." : `Switch TronLink to ${IS_TRON_MAINNET_MODE ? "Mainnet" : "Nile Testnet"}`}
        </button>
      )}
      {notifyStatus === "failed" && (
        <p className="muted">
          Subscribed, but couldn't reach the notification server to save your email — renewal emails won't
          be sent. Is <code>npm run server</code> running?
        </p>
      )}
    </section>
  );
}
