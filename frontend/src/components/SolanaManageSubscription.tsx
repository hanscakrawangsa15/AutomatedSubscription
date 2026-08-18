import { useCallback, useEffect, useState } from "react";
import { Transaction } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getConnection, getProgram, getSolanaAddresses, planPda, solanaStatusToNumber, SUBSCRIPTION_STATUS_SOLANA, subscriptionPda } from "../lib/solanaProgram";
import { useSolanaWallet } from "../hooks/useSolanaWallet";
import { classifyInterval, formatDuration } from "../lib/plans";
import { formatTxError } from "../lib/errors";

const PLAN_LABELS: Record<string, string> = { monthly: "Monthly", yearly: "Yearly", test: "Test" };

type SolanaManageSubscriptionProps = {
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

export function SolanaManageSubscription({ refreshKey, onChanged, justSubscribed }: SolanaManageSubscriptionProps) {
  const { account, publicKey, sendTransaction } = useSolanaWallet();
  const [info, setInfo] = useState<SubInfo | null>(null);
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "pending" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!publicKey) return;
    try {
      const program = getProgram();
      const addrs = getSolanaAddresses();
      if (!program || !addrs) return;

      const subscription = subscriptionPda(addrs.config, publicKey, addrs.programId);
      const sub = await program.account.subscription.fetch(subscription);
      const plan = await program.account.plan.fetch(planPda(addrs.config, Number(sub.planId), addrs.programId));
      const intervalSeconds = Number(plan.interval);
      const kind = classifyInterval(intervalSeconds / 86400);

      setInfo({
        planId: Number(sub.planId),
        status: solanaStatusToNumber(sub.status as Record<string, unknown>),
        nextChargeAt: Number(sub.nextChargeAt),
        overdueSince: Number(sub.overdueSince),
        periodsPaid: Number(sub.periodsPaid),
        planLabel: PLAN_LABELS[kind] ?? `Plan #${sub.planId}`,
        intervalSeconds,
      });

      const userTokenAccount = getAssociatedTokenAddressSync(addrs.mint, publicKey);
      const account_ = await getAccount(getConnection(), userTokenAccount).catch(() => null);
      setWalletBalance(account_ ? (Number(account_.amount) / 1_000_000).toFixed(2) : "0.00");
    } catch (err) {
      setErrorMsg(formatTxError(err));
    }
  }, [publicKey]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const run = async (action: () => Promise<import("@solana/web3.js").TransactionInstruction>) => {
    if (!publicKey) return;
    setStatus("pending");
    setErrorMsg(null);
    try {
      const ix = await action();
      const connection = getConnection();
      // See SolanaConfirmSubscription.tsx's comment: fetching blockhash/
      // lastValidBlockHeight ourselves lets confirmTransaction use the
      // reliable {signature, blockhash, lastValidBlockHeight} form instead
      // of the signature-only overload, which can spuriously time out.
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(ix);
      const sig = await sendTransaction(tx, connection);
      const confirmation = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (confirmation.value.err) {
        throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }
      await load();
      onChanged();
      setStatus("idle");
    } catch (err) {
      setErrorMsg(formatTxError(err));
      setStatus("error");
    }
  };

  // Anchor 1.1.2 auto-resolves `plan`/`subscription` (derivable PDAs),
  // `config` (via a has_one relation, where applicable), and `tokenProgram`
  // (a well-known program ID) from whatever's explicitly passed below — its
  // generated types reject supplying them redundantly. `user` is passed
  // explicitly in every case (rather than relying on Anchor's
  // infer-from-provider-wallet fallback) since lib/solanaProgram.ts's
  // shared Program instance is deliberately backed by a read-only dummy
  // wallet, not the actually-connected one.
  const cancel = () =>
    run(async () => {
      const program = getProgram();
      const addrs = getSolanaAddresses();
      if (!program || !addrs || !publicKey) throw new Error("Solana program isn't configured.");
      return program.methods.cancel().accounts({ user: publicKey, config: addrs.config }).instruction();
    });

  const payNow = () =>
    run(async () => {
      const program = getProgram();
      const addrs = getSolanaAddresses();
      if (!program || !addrs || !publicKey) throw new Error("Solana program isn't configured.");
      const userTokenAccount = getAssociatedTokenAddressSync(addrs.mint, publicKey);
      return program.methods
        .payNow()
        .accounts({ user: publicKey, userTokenAccount, treasuryTokenAccount: addrs.treasuryTokenAccount })
        .instruction();
    });

  const retryCharge = () =>
    run(async () => {
      const program = getProgram();
      const addrs = getSolanaAddresses();
      if (!program || !addrs || !publicKey) throw new Error("Solana program isn't configured.");
      const userTokenAccount = getAssociatedTokenAddressSync(addrs.mint, publicKey);
      return program.methods
        .retryCharge()
        .accounts({ user: publicKey, userTokenAccount, treasuryTokenAccount: addrs.treasuryTokenAccount })
        .instruction();
    });

  if (!info) return <p className="muted">Loading your subscription...</p>;

  const statusLabel = SUBSCRIPTION_STATUS_SOLANA[info.status] ?? "Unknown";

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
          Your last charge failed (insufficient balance or delegated amount). Pay now to stay active before
          the grace period ends.
        </p>
      )}

      <p className="muted">
        Renewals are charged automatically every {formatDuration(info.intervalSeconds)} by an off-chain
        keeper (scripts/keeper.solana.js) calling the program — make sure your wallet keeps enough USDT
        balance and delegated amount approved to the Config account.
      </p>

      {account && (
        <p className="muted" style={{ fontSize: "0.85em" }}>
          Note: renewal activity history isn't tracked for the Solana pilot yet (no on-chain events wired up)
          — status and next-charge above are always live, this is display-only.
        </p>
      )}

      {status === "pending" && <p className="muted">Check Phantom for a confirmation popup.</p>}

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
