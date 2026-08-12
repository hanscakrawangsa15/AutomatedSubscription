import { useState } from "react";
import { getTronUsdc } from "../lib/tronContracts";
import { formatTxError } from "../lib/errors";

const FEE_LIMIT = 150_000_000;

type TronDevToolsProps = {
  account: string;
  onChanged: () => void;
};

/**
 * Lean Tron dev-tools panel — mint only (per the plan's explicit scope: no
 * Tron equivalent of the EVM PlansCard/KeeperCard admin tools in this
 * pass). Rendered as soon as a TronLink wallet is connected, not only
 * after subscribing — a brand-new test wallet has 0 USDT and needs to mint
 * before it can approve/subscribe at all.
 */
export function TronDevTools({ account, onChanged }: TronDevToolsProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("1000");
  const [status, setStatus] = useState<"idle" | "pending" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mint = async () => {
    setStatus("pending");
    setErrorMsg(null);
    try {
      const usdc = getTronUsdc();
      const decimals = await usdc.decimals().call();
      const raw = BigInt(Math.floor(Number(amount || "0"))) * 10n ** BigInt(decimals);
      await usdc.mint(account, raw).send({ feeLimit: FEE_LIMIT, shouldPollResponse: true });
      setStatus("idle");
      onChanged();
    } catch (err) {
      setErrorMsg(formatTxError(err));
      setStatus("error");
    }
  };

  return (
    <div className="dev-tools">
      <button className="link-button" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide" : "Show"} testnet dev tools
      </button>
      {open && (
        <div className="grid">
          <section className="card">
            <h2>Test USDT</h2>
            <div className="row">
              <input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" />
              <button onClick={mint} disabled={status === "pending"}>
                Mint to myself
              </button>
            </div>
            {status === "pending" && (
              <p className="muted">Check TronLink for a confirmation popup. Nile testnet can take up to a minute to confirm.</p>
            )}
            {errorMsg && <p className="error">{errorMsg}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
