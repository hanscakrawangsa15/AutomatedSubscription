import { useState } from "react";
import type { JsonRpcSigner } from "ethers";
import { UsdcCard } from "./UsdcCard";
import { PlansCard } from "./PlansCard";
import { KeeperCard } from "./KeeperCard";
import { TimeTravelCard } from "./TimeTravelCard";
import { isLocalChain } from "../lib/chains";

type DevToolsProps = {
  signer: JsonRpcSigner;
  account: string;
  chainId: number | bigint;
  isOwner: boolean;
  refreshKey: number;
  onChanged: () => void;
};

export function DevTools({ signer, account, chainId, isOwner, refreshKey, onChanged }: DevToolsProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="dev-tools">
      <button className="link-button" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide" : "Show"} testnet dev tools
      </button>
      {open && (
        <div className="grid">
          <UsdcCard signer={signer} account={account} chainId={chainId} refreshKey={refreshKey} onChanged={onChanged} />
          <PlansCard
            signer={signer}
            account={account}
            chainId={chainId}
            isOwner={isOwner}
            refreshKey={refreshKey}
            onChanged={onChanged}
          />
          <KeeperCard signer={signer} chainId={chainId} onChanged={onChanged} />
          {isLocalChain(chainId) && <TimeTravelCard onChanged={onChanged} />}
        </div>
      )}
    </div>
  );
}
