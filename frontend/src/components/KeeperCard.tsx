import { useState } from "react";
import type { JsonRpcSigner } from "ethers";
import { getSubscriptionManager } from "../lib/contracts";
import { useTxStatus } from "../hooks/useTxStatus";

type KeeperCardProps = {
  signer: JsonRpcSigner;
  chainId: number | bigint;
  onChanged: () => void;
};

export function KeeperCard({ signer, chainId, onChanged }: KeeperCardProps) {
  const [targetUser, setTargetUser] = useState("");
  const { status, run } = useTxStatus();
  const [lastAction, setLastAction] = useState<string | null>(null);

  const call = (action: "chargeDue" | "expireOverdue" | "retryCharge") =>
    run(async () => {
      if (!targetUser) throw new Error("Enter a user address first");
      setLastAction(action);
      const manager = getSubscriptionManager(signer, chainId);
      const tx = await manager[action](targetUser);
      await tx.wait();
      onChanged();
    });

  return (
    <section className="card">
      <h2>Keeper Tools</h2>
      <p className="muted">
        These functions are permissionless — anyone can call them for any user, simulating what a
        bot/cron/Chainlink Automation keeper would do to process due charges.
      </p>
      <div className="row">
        <input
          value={targetUser}
          onChange={(e) => setTargetUser(e.target.value)}
          placeholder="User address (0x...)"
        />
      </div>
      <div className="row">
        <button onClick={() => call("chargeDue")} disabled={status === "pending"}>
          chargeDue(user)
        </button>
        <button onClick={() => call("retryCharge")} disabled={status === "pending"}>
          retryCharge(user)
        </button>
        <button onClick={() => call("expireOverdue")} disabled={status === "pending"}>
          expireOverdue(user)
        </button>
      </div>
      {status === "error" && (
        <p className="error">
          {lastAction} failed. Common reasons: not due yet, not overdue, or grace period not passed. See
          console for details.
        </p>
      )}
    </section>
  );
}
