import { useEffect, useState } from "react";
import type { JsonRpcSigner } from "ethers";
import { getMockUsdc, getSubscriptionManager, getChainAddresses } from "../lib/contracts";
import { formatTxError } from "../lib/errors";
import { formatDuration, type PlanInfo } from "../lib/plans";
import { EMAIL_RE, registerNotificationEmail } from "../lib/notify";

const PLAN_LABELS: Record<string, string> = { monthly: "Monthly", yearly: "Yearly", test: "Test" };

const PERIODS_TO_APPROVE = 12n;

type Step = "checking" | "ready" | "approving" | "subscribing" | "error";

type ConfirmSubscriptionProps = {
  signer: JsonRpcSigner;
  account: string;
  chainId: number | bigint;
  plan: PlanInfo;
  onBack: () => void;
  onSubscribed: () => void;
};

export function ConfirmSubscription({
  signer,
  account,
  chainId,
  plan,
  onBack,
  onSubscribed,
}: ConfirmSubscriptionProps) {
  const [step, setStep] = useState<Step>("checking");
  const [needsApproval, setNeedsApproval] = useState<boolean | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [notifyStatus, setNotifyStatus] = useState<"idle" | "sent" | "failed">("idle");

  const managerAddress = getChainAddresses(chainId)?.manager;

  useEffect(() => {
    if (!managerAddress) {
      setErrorMsg(`SubscriptionManager isn't configured for chain ${chainId}.`);
      setStep("error");
      return;
    }
    let cancelled = false;
    getMockUsdc(signer, chainId)
      .allowance(account, managerAddress)
      .then((allowance: bigint) => {
        if (cancelled) return;
        setNeedsApproval(allowance < plan.priceRaw);
        setStep("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorMsg(formatTxError(err));
        setStep("error");
      });
    return () => {
      cancelled = true;
    };
  }, [signer, account, chainId, managerAddress, plan.priceRaw]);

  const confirmAndSubscribe = async () => {
    if (!managerAddress) return;
    setErrorMsg(null);
    try {
      if (needsApproval) {
        setStep("approving");
        const usdc = getMockUsdc(signer, chainId);
        const tx = await usdc.approve(managerAddress, plan.priceRaw * PERIODS_TO_APPROVE);
        await tx.wait();
      }

      setStep("subscribing");
      const manager = getSubscriptionManager(signer, chainId);
      const tx = await manager.subscribe(plan.id);
      await tx.wait();

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
          <strong>{plan.price} USDC</strong>
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

      <label className="field-label" htmlFor="notify-email">
        Email for renewal receipts (optional)
      </label>
      <input
        id="notify-email"
        type="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={busy}
      />

      {needsApproval === true && (
        <p className="muted">
          You'll be asked to confirm <strong>twice</strong>: first to approve USDC spending (covering{" "}
          {PERIODS_TO_APPROVE.toString()} billing cycles, so you won't be asked again for a while), then to
          start your subscription.
        </p>
      )}
      {needsApproval === false && (
        <p className="muted">
          You already approved enough USDC — this only needs <strong>one</strong> wallet confirmation.
        </p>
      )}

      <ol className="step-indicator">
        {needsApproval !== false && (
          <li className={step === "approving" ? "active" : step === "subscribing" ? "done" : ""}>
            Approve USDC spending
          </li>
        )}
        <li className={step === "subscribing" ? "active" : ""}>Confirm subscription</li>
      </ol>

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
      {notifyStatus === "failed" && (
        <p className="muted">
          Subscribed, but couldn't reach the notification server to save your email — renewal emails won't
          be sent. Is <code>npm run server</code> running?
        </p>
      )}
    </section>
  );
}
