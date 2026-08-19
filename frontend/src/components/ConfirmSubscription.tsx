import { useEffect, useState } from "react";
import { formatUnits, type JsonRpcSigner } from "ethers";
import { getMockUsdc, getSubscriptionManager, getChainAddresses } from "../lib/contracts";
import { formatTxError } from "../lib/errors";
import { formatDuration, type PlanInfo } from "../lib/plans";
import { EMAIL_RE, reportSubscription } from "../lib/notify";
import { getChainSlug } from "../lib/chains";
import { getTrafficSource, getEmailFromUrl } from "../lib/trafficSource";
import { useToast } from "./Toast";

const PLAN_LABELS: Record<string, string> = { monthly: "Monthly", yearly: "Yearly", test: "Test" };

// Set to 12 (a full year of monthly renewals) on purpose, per a deliberate
// call to prioritize fewer re-approval interruptions over Blockaid's
// "deceptive request" false-positive rate — wallet security scanners flag
// approvals that are a large multiple of the immediate charge, so this
// *will* surface that warning more often than a lower multiplier would.
// If that turns out to hurt conversion, dial it back down.
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
  // Some tokens (real mainnet USDT included) revert if you approve a
  // nonzero amount over an already-nonzero allowance — a stale partial
  // allowance must be reset to 0 first. Tracked generically (not
  // symbol-matched) so any token with the same quirk is handled the same
  // way, and so it costs nothing extra for a token that doesn't need it.
  const [needsReset, setNeedsReset] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Pre-filled from ?email= when the main Xenorize site links a
  // already-logged-in user into this checkout (e.g.
  // https://cpay.xenorize.com/?email=user@example.com&source=stg) — still
  // editable, and still required, since not every entry point supplies it.
  const [email, setEmail] = useState(() => getEmailFromUrl() ?? "");
  const [emailTouched, setEmailTouched] = useState(false);
  const [notifyStatus, setNotifyStatus] = useState<"idle" | "sent" | "failed">("idle");
  const emailValid = EMAIL_RE.test(email);
  const showToast = useToast();

  const managerAddress = getChainAddresses(chainId, plan.tokenSuffix)?.manager;

  useEffect(() => {
    if (!managerAddress) {
      setErrorMsg(`SubscriptionManager isn't configured for chain ${chainId}.`);
      setStep("error");
      return;
    }
    let cancelled = false;
    getMockUsdc(signer, chainId, plan.tokenSuffix)
      .allowance(account, managerAddress)
      .then((allowance: bigint) => {
        if (cancelled) return;
        const target = plan.priceRaw * PERIODS_TO_APPROVE;
        setNeedsApproval(allowance < target);
        setNeedsReset(allowance > 0n && allowance < target);
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
  }, [signer, account, chainId, managerAddress, plan.priceRaw, plan.tokenSuffix]);

  const confirmAndSubscribe = async () => {
    if (!managerAddress || !emailValid) return;
    setErrorMsg(null);
    try {
      if (needsApproval) {
        setStep("approving");
        const usdc = getMockUsdc(signer, chainId, plan.tokenSuffix);
        if (needsReset) {
          const resetTx = await usdc.approve(managerAddress, 0n);
          await resetTx.wait();
        }
        const tx = await usdc.approve(managerAddress, plan.priceRaw * PERIODS_TO_APPROVE);
        await tx.wait();
      }

      setStep("subscribing");
      const manager = getSubscriptionManager(signer, chainId, plan.tokenSuffix);
      const tx = await manager.subscribe(plan.id);
      await tx.wait();
      // periodsPaid is a lifetime counter on the contract (persists across
      // cancel -> resubscribe cycles), so it isn't necessarily 1 here —
      // read the real value rather than assume.
      const sub = await manager.subscriptions(account);

      const ok = await reportSubscription({
        address: account,
        chainName: getChainSlug(chainId),
        chainId: Number(chainId),
        email,
        trafficSource: getTrafficSource(),
        planId: plan.id,
        planLabel: PLAN_LABELS[plan.kind] ?? plan.kind,
        txHash: tx.hash,
        amountLabel: `${plan.price} ${plan.tokenSymbol}`,
        intervalLabel: `every ${formatDuration(plan.intervalSeconds)}`,
        periodsPaid: Number(sub.periodsPaid),
        nextChargeAt: Number(sub.nextChargeAt),
      });
      setNotifyStatus(ok ? "sent" : "failed");

      showToast("success", `Subscribed! ${plan.price} ${plan.tokenSymbol} charged — you're all set.`);
      onSubscribed();
    } catch (err) {
      const message = formatTxError(err);
      setErrorMsg(message);
      showToast("error", message);
      setStep("ready");
    }
  };

  const busy = step === "approving" || step === "subscribing";
  // Precise bigint-based formatting, not Number(plan.price) * N — that loses
  // precision for tokens with small fractional prices (e.g. WETH plans
  // priced at ~0.005 tokens), where toFixed(2) rounded 0.015735 to "0.02".
  const approveCapDisplay = formatUnits(plan.priceRaw * PERIODS_TO_APPROVE, plan.decimals);

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
          <strong>
            {plan.price} {plan.tokenSymbol}
          </strong>
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
        Email for renewal receipts (required)
      </label>
      <input
        id="notify-email"
        type="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={() => setEmailTouched(true)}
        disabled={busy}
        required
      />
      {emailTouched && !emailValid && <p className="error">Enter a valid email address to continue.</p>}

      {needsApproval === true && (
        <div className="banner banner--info">
          You'll confirm <strong>{needsReset ? "up to three times" : "twice"}</strong> in your wallet:
          <ol style={{ margin: "6px 0", paddingLeft: 20 }}>
            {needsReset && (
              <li>
                <strong>Reset your existing {plan.tokenSymbol} allowance to 0.</strong> {plan.tokenSymbol} requires
                clearing an old spending cap before setting a new one — a one-time housekeeping step, no funds move.
              </li>
            )}
            <li>
              <strong>
                Approve spending cap: {approveCapDisplay} {plan.tokenSymbol}.
              </strong>{" "}
              This is a permission ceiling, not a charge — nothing is taken from your wallet in this step. It covers{" "}
              {PERIODS_TO_APPROVE.toString()} billing cycles so you won't be asked again for a while.
            </li>
            <li>
              <strong>
                Subscribe — charges {plan.price} {plan.tokenSymbol} now.
              </strong>{" "}
              Only this amount actually leaves your wallet today. Future renewals pull {plan.price} {plan.tokenSymbol}{" "}
              automatically from the approved cap, with no further wallet confirmation needed — until the cap runs
              out.
            </li>
          </ol>
        </div>
      )}
      {needsApproval === false && (
        <p className="muted">
          You already approved enough {plan.tokenSymbol} — this only needs <strong>one</strong> wallet confirmation.
        </p>
      )}

      <ol className="step-indicator">
        {needsApproval !== false && (
          <li className={step === "approving" ? "active" : step === "subscribing" ? "done" : ""}>
            Approve {plan.tokenSymbol} spending
          </li>
        )}
        <li className={step === "subscribing" ? "active" : ""}>Confirm subscription</li>
      </ol>

      <div className="row">
        <button onClick={onBack} disabled={busy} className="secondary">
          Back
        </button>
        <button
          onClick={confirmAndSubscribe}
          disabled={busy || step === "checking" || step === "error" || !emailValid}
        >
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
