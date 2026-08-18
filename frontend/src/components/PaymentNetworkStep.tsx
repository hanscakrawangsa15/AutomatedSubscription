import { useEffect, useState } from "react";
import { useAppKitNetwork } from "@reown/appkit/react";
import type { AppKitNetwork } from "@reown/appkit/networks";
import { ETH_MAINNET, BSC_MAINNET } from "../lib/chains";
import { getReadProvider } from "../lib/readProvider";
import { fetchPlans, type PlanInfo } from "../lib/plans";
import { PRICING_TIERS, TEST_TIER, findOnChainPlan, type BillingCycle, type PricingTier } from "../lib/pricingTiers";

// Both networks pay in USDT — Ethereum's USDT manager uses the "_USDT"
// suffix (USDC is Ethereum's primary/unsuffixed token), while BNB Chain's
// USDT manager IS the primary/unsuffixed one (suffix "") — see
// docs/mainnet-addresses.md.
const NETWORKS: { chain: AppKitNetwork; suffix: string; label: string; standard: string }[] = [
  { chain: ETH_MAINNET, suffix: "_USDT", label: "Ethereum", standard: "ERC-20" },
  { chain: BSC_MAINNET, suffix: "", label: "BNB Chain", standard: "BEP-20" },
];

type PaymentNetworkStepProps = {
  tierId: PricingTier["id"];
  cycle: BillingCycle;
  chainId: bigint | null;
  onResolved: (plan: PlanInfo) => void;
  onBack: () => void;
};

export function PaymentNetworkStep({ tierId, cycle, chainId, onResolved, onBack }: PaymentNetworkStepProps) {
  const { switchNetwork } = useAppKitNetwork();
  // The chainId the user picked and is waiting to land on — cleared once
  // resolution finishes (success or failure). Distinct from the wallet's
  // *actual* current chainId (the chainId prop), which only catches up
  // asynchronously once the wallet confirms the network switch.
  const [pendingChainId, setPendingChainId] = useState<number | null>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fires once the wallet's actual chain catches up to what the user picked
  // (or immediately, if they picked the network they were already on).
  useEffect(() => {
    if (pendingChainId === null) return;
    if (chainId === null || Number(chainId) !== pendingChainId) return;

    const target = NETWORKS.find((n) => Number(n.chain.id) === pendingChainId);
    const provider = getReadProvider(pendingChainId);
    if (!target || !provider) {
      setError(`No RPC configured for chain ${pendingChainId}`);
      setPendingChainId(null);
      return;
    }

    setResolving(true);
    let cancelled = false;
    fetchPlans(provider, pendingChainId, target.suffix)
      .then((plans) => {
        if (cancelled) return;
        const tier = [...PRICING_TIERS, TEST_TIER].find((t) => t.id === tierId);
        const match = tier ? findOnChainPlan(plans, tier, cycle) : undefined;
        if (match) {
          onResolved(match);
        } else {
          setError(`This plan isn't available on ${target.label} yet — try the other network.`);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load this network's plan");
      })
      .finally(() => {
        if (!cancelled) {
          setResolving(false);
          setPendingChainId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pendingChainId, chainId, tierId, cycle, onResolved]);

  const handlePick = async (network: (typeof NETWORKS)[number]) => {
    setError(null);
    const targetId = Number(network.chain.id);
    setPendingChainId(targetId);
    if (chainId !== null && Number(chainId) === targetId) return; // already there — the effect above resolves immediately
    try {
      await switchNetwork(network.chain);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch network");
      setPendingChainId(null);
    }
  };

  const busy = pendingChainId !== null;

  return (
    <section className="checkout-step">
      <h2>Choose payment network</h2>
      <p className="muted" style={{ textAlign: "center" }}>
        You'll pay in USDT. Pick the network your wallet should use — we'll prompt it to switch automatically.
      </p>

      <div className="wallet-list">
        {NETWORKS.map((network) => {
          const targetId = Number(network.chain.id);
          const isPending = pendingChainId === targetId;
          return (
            <button
              key={network.standard}
              className="wallet-option"
              disabled={busy}
              onClick={() => handlePick(network)}
            >
              <span>
                Pay with USDT · {network.standard} ({network.label})
              </span>
              {isPending && <span className="muted">{resolving ? "Loading plan..." : "Confirm in your wallet..."}</span>}
            </button>
          );
        })}
      </div>

      {error && <p className="error">{error}</p>}

      <button className="link-button" onClick={onBack} disabled={busy}>
        &larr; Back to plans
      </button>
    </section>
  );
}
