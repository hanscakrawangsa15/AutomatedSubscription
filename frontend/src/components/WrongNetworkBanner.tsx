import { useState } from "react";
import { useAppKitNetwork } from "@reown/appkit/react";
import type { AppKitNetwork } from "@reown/appkit/networks";
import { SUPPORTED_CHAINS, getChainName } from "../lib/chains";
import { isChainDeployed } from "../lib/contracts";

type WrongNetworkBannerProps = {
  currentChainId: bigint;
};

export function WrongNetworkBanner({ currentChainId }: WrongNetworkBannerProps) {
  const { switchNetwork } = useAppKitNetwork();
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const availableChains = SUPPORTED_CHAINS.filter((chain) => isChainDeployed(Number(chain.id)));

  const handleSwitch = async (chain: AppKitNetwork) => {
    setSwitchingTo(String(chain.id));
    setError(null);
    try {
      await switchNetwork(chain);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch network");
    } finally {
      setSwitchingTo(null);
    }
  };

  return (
    <div className="banner banner--warning">
      {availableChains.length === 0 ? (
        <>
          Your wallet is on {getChainName(currentChainId)} (chain {currentChainId.toString()}), but
          SubscriptionManager isn't deployed to any network in this build yet — there's nothing to switch
          to right now.
        </>
      ) : (
        <>
          Your wallet is on {getChainName(currentChainId)} (chain {currentChainId.toString()}), which isn't
          set up yet. Switch to a supported network to continue.
        </>
      )}
      <div className="row">
        {availableChains.map((chain) => (
          <button key={chain.id} onClick={() => handleSwitch(chain)} disabled={switchingTo !== null}>
            {switchingTo === String(chain.id) ? "Switching..." : `Switch to ${chain.name}`}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
