import { useEffect, useState } from "react";
import { Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createApproveInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getConnection, getProgram, getSolanaAddresses, IS_SOLANA_MAINNET_MODE } from "../lib/solanaProgram";
import { useSolanaWallet } from "../hooks/useSolanaWallet";
import { formatDuration, type SolanaPlanInfo } from "../lib/solanaPlans";
import { formatTxError } from "../lib/errors";
import { EMAIL_RE, reportSubscription } from "../lib/notify";
import { getTrafficSource } from "../lib/trafficSource";

const PLAN_LABELS: Record<string, string> = { monthly: "Monthly", yearly: "Yearly", test: "Test" };

// Bounded approval, matching PERIODS_TO_APPROVE on the EVM side —
// approves 3 periods worth up front so a few keeper-driven renewals don't
// need a fresh wallet confirmation each time. Unlike EVM's real USDT, SPL
// `approve` unconditionally overwrites the delegated amount (no reset-to-
// zero dance needed — see the plan doc).
const PERIODS_TO_APPROVE = 3n;

type Step = "checking" | "ready" | "subscribing" | "error";

type SolanaConfirmSubscriptionProps = {
  plan: SolanaPlanInfo;
  onBack: () => void;
  onSubscribed: () => void;
};

export function SolanaConfirmSubscription({ plan, onBack, onSubscribed }: SolanaConfirmSubscriptionProps) {
  const { account, publicKey, sendTransaction } = useSolanaWallet();
  const [step, setStep] = useState<Step>("checking");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [notifyStatus, setNotifyStatus] = useState<"idle" | "sent" | "failed">("idle");

  useEffect(() => {
    setStep("ready");
  }, [plan.id]);

  const confirmAndSubscribe = async () => {
    if (!publicKey) return;
    setErrorMsg(null);
    setStep("subscribing");
    try {
      const program = getProgram();
      const addrs = getSolanaAddresses();
      if (!program || !addrs) throw new Error("Solana program isn't configured.");

      const connection = getConnection();
      const userTokenAccount = getAssociatedTokenAddressSync(addrs.mint, publicKey);
      const approveAmount = plan.priceRaw * PERIODS_TO_APPROVE;

      const approveIx = createApproveInstruction(
        userTokenAccount,
        addrs.config,
        publicKey,
        approveAmount,
        [],
        TOKEN_PROGRAM_ID,
      );

      // Anchor 1.1.2 auto-resolves `config` (via `plan`'s has_one relation),
      // `subscription` (a derivable PDA), and `tokenProgram`/`systemProgram`
      // (well-known program IDs) — its generated types reject passing them
      // explicitly here. `user` is technically optional too (Anchor can
      // infer a Signer from the provider's wallet) but that provider is a
      // read-only dummy (see lib/solanaProgram.ts), so it's passed
      // explicitly to make sure the actually-connected wallet is used.
      const subscribeIx = await program.methods
        .subscribe()
        .accounts({ user: publicKey, plan: plan.planPda, userTokenAccount, treasuryTokenAccount: addrs.treasuryTokenAccount })
        .instruction();

      // One transaction, one wallet confirmation — Solana lets approve+
      // subscribe ship together, unlike EVM's two separate txs (see
      // the plan doc's design note on this).
      // Fetching blockhash/lastValidBlockHeight ourselves (rather than
      // leaving it to the wallet adapter's internal default) lets us pass
      // the *same* values to confirmTransaction below — the signature-only
      // confirmTransaction(sig) overload is a known-unreliable web3.js
      // pattern that can time out even when the transaction actually
      // landed; this is the pattern Solana's own docs recommend instead.
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(approveIx, subscribeIx);
      const sig = await sendTransaction(tx, connection);
      const confirmation = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (confirmation.value.err) {
        throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }

      if (account) {
        const ok = await reportSubscription({
          address: account,
          chainName: IS_SOLANA_MAINNET_MODE ? "solana-mainnet" : "solana-devnet",
          chainId: null,
          email: email && EMAIL_RE.test(email) ? email : undefined,
          trafficSource: getTrafficSource(),
          planId: plan.id,
          planLabel: PLAN_LABELS[plan.kind] ?? plan.kind,
          txHash: sig,
        });
        if (email && EMAIL_RE.test(email)) setNotifyStatus(ok ? "sent" : "failed");
      }

      onSubscribed();
    } catch (err) {
      setErrorMsg(formatTxError(err));
      setStep("ready");
    }
  };

  const busy = step === "subscribing";

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
            {account ? `${account.slice(0, 6)}...${account.slice(-4)}` : "-"}
          </strong>
        </div>
      </div>

      <label className="field-label" htmlFor="solana-notify-email">
        Email for renewal receipts (optional)
      </label>
      <input
        id="solana-notify-email"
        type="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={busy}
      />

      <div className="banner banner--info">
        You'll confirm <strong>once</strong> in Phantom:
        <ol style={{ margin: "6px 0", paddingLeft: 20 }}>
          <li>
            <strong>
              Approve spending cap: {(Number(plan.price) * Number(PERIODS_TO_APPROVE)).toFixed(2)} USDT
            </strong>{" "}
            and <strong>subscribe — charges {plan.price} USDT now</strong>, both in one transaction. The
            approval covers {PERIODS_TO_APPROVE.toString()} billing cycles so future renewals need no further
            wallet confirmation, until the cap runs out.
          </li>
        </ol>
        <p style={{ margin: "6px 0 0" }}>
          Phantom may label this token <strong>"Unknown"</strong> in that confirmation screen instead of
          "USDT" — that's expected, not a red flag. It just means the token isn't in Phantom's own name/logo
          list yet; the amounts shown ({plan.price} now, up to{" "}
          {(Number(plan.price) * Number(PERIODS_TO_APPROVE)).toFixed(2)} approved) are still accurate.
        </p>
      </div>

      <div className="row">
        <button onClick={onBack} disabled={busy} className="secondary">
          Back
        </button>
        <button onClick={confirmAndSubscribe} disabled={busy || step === "checking" || step === "error" || !publicKey}>
          {step === "checking" && "Checking..."}
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
