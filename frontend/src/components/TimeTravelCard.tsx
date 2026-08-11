import { useState } from "react";
import { JsonRpcProvider } from "ethers";
import { LOCAL_CHAIN } from "../lib/chains";

const LOCAL_RPC_URL = LOCAL_CHAIN.rpcUrls.default.http[0];

type TimeTravelCardProps = {
  onChanged: () => void;
};

const PRESETS = [
  { label: "+1 hour", seconds: 60 * 60 },
  { label: "+1 day", seconds: 24 * 60 * 60 },
  { label: "+31 days", seconds: 31 * 24 * 60 * 60 },
  { label: "+366 days", seconds: 366 * 24 * 60 * 60 },
];

export function TimeTravelCard({ onChanged }: TimeTravelCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastJump, setLastJump] = useState<string | null>(null);

  const fastForward = async (seconds: number, label: string) => {
    setBusy(true);
    setError(null);
    try {
      const rpc = new JsonRpcProvider(LOCAL_RPC_URL);
      await rpc.send("evm_increaseTime", [seconds]);
      await rpc.send("evm_mine", []);
      setLastJump(label);
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to advance time — this only works against a local Hardhat node.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Time Travel (local chain only)</h2>
      <p className="muted">
        Fast-forwards the Hardhat node's clock so you can test renewals (chargeDue) without waiting for the
        real billing interval. The plan's interval itself doesn't change — this just skips ahead past it.
      </p>
      <div className="row">
        {PRESETS.map((p) => (
          <button key={p.label} onClick={() => fastForward(p.seconds, p.label)} disabled={busy}>
            {p.label}
          </button>
        ))}
      </div>
      {lastJump && <p className="muted">Last jump: {lastJump}. Chain time advanced and a block was mined.</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
