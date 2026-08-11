import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { useAppKitWallet } from "./hooks/useAppKitWallet";
import { WalletBar } from "./components/WalletBar";
import { PlanPicker } from "./components/PlanPicker";
import { ConnectWalletStep } from "./components/ConnectWalletStep";
import { ConfirmSubscription } from "./components/ConfirmSubscription";
import { ManageSubscription } from "./components/ManageSubscription";
import { DevTools } from "./components/DevTools";
import { WrongNetworkBanner } from "./components/WrongNetworkBanner";
import { getSubscriptionManager, isChainDeployed } from "./lib/contracts";
import { SUPPORTED_CHAINS, DEFAULT_CHAIN, isMainnetChain, IS_MAINNET_MODE } from "./lib/chains";
import type { PlanInfo } from "./lib/plans";

const ACTIVE = 1;
const OVERDUE = 2;

const DEFAULT_CHAIN_ID = BigInt(DEFAULT_CHAIN.id);
const ANY_CHAIN_CONFIGURED = SUPPORTED_CHAINS.some((c) => isChainDeployed(Number(c.id)));

function App() {
  const { signer, account, chainId, connecting, error, connect, disconnect } = useAppKitWallet();
  const [refreshKey, setRefreshKey] = useState(0);
  const [isOwner, setIsOwner] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<PlanInfo | null>(null);
  const [justSubscribed, setJustSubscribed] = useState(false);
  const [subStatus, setSubStatus] = useState<number | null>(null);

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Before a wallet connects (or if it's on an unconfigured chain), default
  // to showing pricing for this build's first supported chain rather than
  // nothing (the local dev chain in testnet mode, Base in mainnet mode).
  const readChainId = chainId ?? DEFAULT_CHAIN_ID;
  const wrongNetwork = chainId !== null && !isChainDeployed(chainId);

  useEffect(() => {
    if (!signer || !account || wrongNetwork || chainId === null) {
      setIsOwner(false);
      setSubStatus(null);
      return;
    }
    const manager = getSubscriptionManager(signer, chainId);
    manager
      .owner()
      .then((owner: string) => setIsOwner(owner.toLowerCase() === account.toLowerCase()))
      .catch(() => setIsOwner(false));
    manager
      .subscriptions(account)
      .then((sub: { status: bigint }) => setSubStatus(Number(sub.status)))
      .catch(() => setSubStatus(null));
  }, [signer, account, chainId, refreshKey, wrongNetwork]);

  const hasSubscription = subStatus === ACTIVE || subStatus === OVERDUE;

  // A plan picked before connecting (shown for the default local chain) can
  // end up stale if the wallet that connects afterward is on a different
  // chain — plan IDs aren't unique across deployments, so re-picking is
  // required rather than silently proceeding with a mismatched plan.
  useEffect(() => {
    if (selectedPlan && chainId !== null && selectedPlan.chainId !== Number(chainId)) {
      setSelectedPlan(null);
    }
  }, [selectedPlan, chainId]);

  const backToPlans = () => {
    setSelectedPlan(null);
    setJustSubscribed(false);
  };

  const currentStep = hasSubscription ? 3 : !selectedPlan ? 1 : !signer || !account ? 2 : 3;

  return (
    <div className="app">
      <WalletBar account={account} chainId={chainId} onDisconnect={disconnect} />

      {!ANY_CHAIN_CONFIGURED && (
        <div className="banner banner--warning">
          No networks have contract addresses configured yet. Deploy with{" "}
          <code>npm run deploy:local</code> (or a testnet variant) and add the printed{" "}
          <code>VITE_USDC_ADDRESS_&lt;chainId&gt;</code> /{" "}
          <code>VITE_SUBSCRIPTION_MANAGER_ADDRESS_&lt;chainId&gt;</code> pair to{" "}
          <code>frontend/.env</code>, then restart the dev server.
        </div>
      )}

      {wrongNetwork && chainId !== null && <WrongNetworkBanner currentChainId={chainId} />}

      {!hasSubscription && (
        <ol className="checkout-progress">
          <li className={currentStep === 1 ? "active" : currentStep > 1 ? "done" : ""}>Choose plan</li>
          <li className={currentStep === 2 ? "active" : currentStep > 2 ? "done" : ""}>Connect wallet</li>
          <li className={currentStep === 3 ? "active" : ""}>Confirm</li>
        </ol>
      )}

      <main className="checkout">
        {hasSubscription && signer && account && chainId !== null ? (
          <ManageSubscription
            signer={signer}
            account={account}
            chainId={chainId}
            refreshKey={refreshKey}
            onChanged={bump}
            justSubscribed={justSubscribed}
          />
        ) : !selectedPlan ? (
          <PlanPicker chainId={readChainId} refreshKey={refreshKey} onSelect={setSelectedPlan} />
        ) : !signer || !account ? (
          <>
            <ConnectWalletStep connecting={connecting} error={error} onConnect={connect} />
            <button className="link-button" onClick={backToPlans}>
              &larr; Back to plans
            </button>
          </>
        ) : wrongNetwork ? (
          <section className="checkout-step">
            <h2>Wrong network</h2>
            <p className="muted">Switch your wallet to a supported network above, then continue.</p>
          </section>
        ) : (
          chainId !== null && (
            <ConfirmSubscription
              signer={signer}
              account={account}
              chainId={chainId}
              plan={selectedPlan}
              onBack={backToPlans}
              onSubscribed={() => {
                setJustSubscribed(true);
                bump();
              }}
            />
          )
        )}
      </main>

      {!IS_MAINNET_MODE && signer && account && chainId !== null && !wrongNetwork && !isMainnetChain(chainId) && (
        <DevTools
          signer={signer}
          account={account}
          chainId={chainId}
          isOwner={isOwner}
          refreshKey={refreshKey}
          onChanged={bump}
        />
      )}
    </div>
  );
}

export default App;
