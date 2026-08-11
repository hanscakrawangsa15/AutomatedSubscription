import { useCallback, useEffect, useState } from "react";
import { formatUnits, parseUnits, type JsonRpcSigner } from "ethers";
import { getMockUsdc, getChainAddresses } from "../lib/contracts";
import { useTxStatus } from "../hooks/useTxStatus";

type UsdcCardProps = {
  signer: JsonRpcSigner;
  account: string;
  chainId: number | bigint;
  refreshKey: number;
  onChanged: () => void;
};

export function UsdcCard({ signer, account, chainId, refreshKey, onChanged }: UsdcCardProps) {
  const [balance, setBalance] = useState<string | null>(null);
  const [allowance, setAllowance] = useState<string | null>(null);
  const [mintAmount, setMintAmount] = useState("1000");
  const [approveAmount, setApproveAmount] = useState("1000");
  const { status, run } = useTxStatus();
  const managerAddress = getChainAddresses(chainId)?.manager;

  const load = useCallback(async () => {
    const usdc = getMockUsdc(signer, chainId);
    const [rawBalance, decimals] = await Promise.all([usdc.balanceOf(account), usdc.decimals()]);
    setBalance(formatUnits(rawBalance, decimals));
    if (managerAddress) {
      const rawAllowance = await usdc.allowance(account, managerAddress);
      setAllowance(formatUnits(rawAllowance, decimals));
    }
  }, [signer, account, chainId, managerAddress]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const mint = () =>
    run(async () => {
      const usdc = getMockUsdc(signer, chainId);
      const decimals = await usdc.decimals();
      const tx = await usdc.mint(account, parseUnits(mintAmount || "0", decimals));
      await tx.wait();
      await load();
      onChanged();
    });

  const approve = () =>
    run(async () => {
      if (!managerAddress) throw new Error("SubscriptionManager not configured for this chain");
      const usdc = getMockUsdc(signer, chainId);
      const decimals = await usdc.decimals();
      const tx = await usdc.approve(managerAddress, parseUnits(approveAmount || "0", decimals));
      await tx.wait();
      await load();
      onChanged();
    });

  return (
    <section className="card">
      <h2>Mock USDC</h2>
      <p>
        Balance: <strong>{balance ?? "..."}</strong> USDC
      </p>
      <p>
        Allowance to SubscriptionManager: <strong>{allowance ?? "..."}</strong> USDC
      </p>

      <div className="row">
        <input
          type="number"
          min="0"
          value={mintAmount}
          onChange={(e) => setMintAmount(e.target.value)}
          placeholder="Amount"
        />
        <button onClick={mint} disabled={status === "pending"}>
          Mint to myself
        </button>
      </div>

      <div className="row">
        <input
          type="number"
          min="0"
          value={approveAmount}
          onChange={(e) => setApproveAmount(e.target.value)}
          placeholder="Amount"
        />
        <button onClick={approve} disabled={status === "pending"}>
          Approve SubscriptionManager
        </button>
      </div>

      {status === "error" && <p className="error">Transaction failed. See console for details.</p>}
    </section>
  );
}
