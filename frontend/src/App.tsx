import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useAppKitNetwork } from "@reown/appkit/react";
import "./App.css";
import { useAppKitWallet } from "./hooks/useAppKitWallet";
import { useTronWallet } from "./hooks/useTronWallet";
import { WalletBar } from "./components/WalletBar";
import { PlanPicker } from "./components/PlanPicker";
import { ConnectWalletStep } from "./components/ConnectWalletStep";
import { ConfirmSubscription } from "./components/ConfirmSubscription";
import { ManageSubscription } from "./components/ManageSubscription";
import { WrongNetworkBanner } from "./components/WrongNetworkBanner";
import { TronPlanPicker } from "./components/TronPlanPicker";
import { TronConfirmSubscription } from "./components/TronConfirmSubscription";
import { TronManageSubscription } from "./components/TronManageSubscription";
import { getSubscriptionManager, isChainDeployed } from "./lib/contracts";
import { getTronSubscriptionManager, isTronConfigured, IS_TRON_MAINNET_MODE } from "./lib/tronContracts";
import { SUPPORTED_CHAINS, isMainnetChain, IS_MAINNET_MODE, getCorrespondingChain } from "./lib/chains";
import type { PlanInfo } from "./lib/plans";
import type { TronPlanInfo } from "./lib/tronPlans";

// Lazy-loaded (not a static import) so this dev-only tooling — and
// everything it pulls in, including TimeTravelCard's reference to
// LOCAL_CHAIN/testnet RPC URLs — lands in its own chunk instead of the main
// bundle. A static import here would ship those strings to every visitor
// regardless of the runtime render check below, including on a real
// mainnet production build where it should never even be fetched.
const DevTools = lazy(() => import("./components/DevTools").then((m) => ({ default: m.DevTools })));
const TronDevTools = lazy(() => import("./components/TronDevTools").then((m) => ({ default: m.TronDevTools })));

const ACTIVE = 1;
const OVERDUE = 2;

const ANY_CHAIN_CONFIGURED = SUPPORTED_CHAINS.some((c) => isChainDeployed(Number(c.id)));

type NetworkFamily = "evm" | "tron";

function EvmApp() {
  const { signer, account, chainId, connecting, error, connect, disconnect } = useAppKitWallet();
  const { switchNetwork } = useAppKitNetwork();
  const [refreshKey, setRefreshKey] = useState(0);
  const [isOwner, setIsOwner] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<PlanInfo | null>(null);
  const [justSubscribed, setJustSubscribed] = useState(false);
  const [subStatus, setSubStatus] = useState<number | null>(null);
  // Only meaningful before a wallet connects (there's no live chain to
  // toggle yet) — affects which chain's plans preview. Once connected, the
  // toggle switches the wallet's actual network instead (handleSwitchMode).
  const [previewMainnet, setPreviewMainnet] = useState(false);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Before a wallet connects (or if it's on an unconfigured chain), default
  // to showing pricing for this build's first supported chain rather than
  // nothing (the local dev chain in testnet mode, Base in mainnet mode) —
  // or the Testnet/Mainnet toggle's chosen preview mode, once touched.
  const readChainId = chainId ?? BigInt(getCorrespondingChain(null, previewMainnet ? "mainnet" : "testnet").id);
  const wrongNetwork = chainId !== null && !isChainDeployed(chainId);

  const handleSwitchMode = async (targetMainnet: boolean) => {
    if (chainId === null) {
      setPreviewMainnet(targetMainnet);
      return;
    }
    setSwitchingMode(true);
    setModeError(null);
    try {
      await switchNetwork(getCorrespondingChain(chainId, targetMainnet ? "mainnet" : "testnet"));
    } catch (err) {
      setModeError(err instanceof Error ? err.message : "Failed to switch network");
    } finally {
      setSwitchingMode(false);
    }
  };

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
      <WalletBar
        account={account}
        chainId={chainId}
        onDisconnect={disconnect}
        onSwitchMode={handleSwitchMode}
        switchingMode={switchingMode}
      />
      {modeError && <p className="error">{modeError}</p>}

      {!ANY_CHAIN_CONFIGURED && IS_MAINNET_MODE && (
        <div className="banner banner--warning">
          SubscriptionManager hasn't been deployed to Base, Ethereum Mainnet, or BNB Chain yet — see{" "}
          <code>docs/mainnet-addresses.md</code> and the mainnet-readiness plan for what's needed before a
          real deploy. Once deployed, add the printed <code>VITE_USDC_ADDRESS_&lt;chainId&gt;</code> /{" "}
          <code>VITE_SUBSCRIPTION_MANAGER_ADDRESS_&lt;chainId&gt;</code> pair to <code>frontend/.env</code>.
        </div>
      )}
      {!ANY_CHAIN_CONFIGURED && !IS_MAINNET_MODE && (
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

      {signer && account && chainId !== null && !wrongNetwork && !isMainnetChain(chainId) && (
        <Suspense fallback={null}>
          <DevTools
            signer={signer}
            account={account}
            chainId={chainId}
            isOwner={isOwner}
            refreshKey={refreshKey}
            onChanged={bump}
          />
        </Suspense>
      )}
    </div>
  );
}

function TronApp() {
  const { account, connecting, error, connect, disconnect } = useTronWallet();
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedPlan, setSelectedPlan] = useState<TronPlanInfo | null>(null);
  const [justSubscribed, setJustSubscribed] = useState(false);
  const [subStatus, setSubStatus] = useState<number | null>(null);
  const deployed = isTronConfigured();

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!account || !deployed) {
      setSubStatus(null);
      return;
    }
    // getTronSubscriptionManager() can throw synchronously (e.g. TronLink
    // connected but on the wrong network) — wrapped in try/catch since a
    // synchronous throw inside a useEffect isn't caught by a trailing
    // .catch() on the promise chain and would otherwise crash the whole
    // React tree (no error boundary in this app).
    try {
      getTronSubscriptionManager()
        .subscriptions(account)
        .call()
        .then((sub) => setSubStatus(Number(sub.status)))
        .catch(() => setSubStatus(null));
    } catch {
      setSubStatus(null);
    }
  }, [account, deployed, refreshKey]);

  const hasSubscription = subStatus === ACTIVE || subStatus === OVERDUE;

  const backToPlans = () => {
    setSelectedPlan(null);
    setJustSubscribed(false);
  };

  const currentStep = hasSubscription ? 3 : !selectedPlan ? 1 : !account ? 2 : 3;

  return (
    <div className="app">
      <header className="wallet-bar">
        <div className="wallet-bar__title">
          <h1>Subscribe</h1>
          <span className={`mode-badge ${IS_TRON_MAINNET_MODE ? "mode-badge--mainnet" : "mode-badge--testnet"}`}>
            {IS_TRON_MAINNET_MODE ? "TRON Mainnet · real funds" : "TRON Nile"}
          </span>
        </div>
        {account && (
          <div className="wallet-bar__actions">
            <span className="pill">
              {account.slice(0, 6)}...{account.slice(-4)}
            </span>
            <button onClick={disconnect} className="secondary">
              Disconnect
            </button>
          </div>
        )}
      </header>

      {!deployed && IS_TRON_MAINNET_MODE && (
        <div className="banner banner--warning">
          TRON Mainnet isn't deployed yet — see docs/mainnet-addresses.md. Add{" "}
          <code>VITE_TRON_MAINNET_USDT_ADDRESS</code> / <code>VITE_TRON_MAINNET_MANAGER_ADDRESS</code> to{" "}
          <code>frontend/.env</code> once deployed.
        </div>
      )}
      {!deployed && !IS_TRON_MAINNET_MODE && (
        <div className="banner banner--warning">
          TRON Nile isn't deployed yet. Run <code>npm run deploy:tron-nile</code> and add the printed{" "}
          <code>VITE_TRON_NILE_USDC_ADDRESS</code> / <code>VITE_TRON_NILE_MANAGER_ADDRESS</code> pair to{" "}
          <code>frontend/.env</code>, then restart the dev server.
        </div>
      )}

      {!hasSubscription && (
        <ol className="checkout-progress">
          <li className={currentStep === 1 ? "active" : currentStep > 1 ? "done" : ""}>Choose plan</li>
          <li className={currentStep === 2 ? "active" : currentStep > 2 ? "done" : ""}>Connect wallet</li>
          <li className={currentStep === 3 ? "active" : ""}>Confirm</li>
        </ol>
      )}

      <main className="checkout">
        {hasSubscription && account ? (
          <TronManageSubscription account={account} refreshKey={refreshKey} onChanged={bump} justSubscribed={justSubscribed} />
        ) : !selectedPlan ? (
          <TronPlanPicker refreshKey={refreshKey} onSelect={setSelectedPlan} />
        ) : !account ? (
          <>
            <ConnectWalletStep
              connecting={connecting}
              error={error}
              onConnect={connect}
              description={`Connect TronLink to subscribe on TRON ${IS_TRON_MAINNET_MODE ? "Mainnet" : "Nile testnet"}.`}
              connectingLabel="Opening TronLink..."
              connectLabel="Connect TronLink"
            />
            <button className="link-button" onClick={backToPlans}>
              &larr; Back to plans
            </button>
          </>
        ) : (
          <TronConfirmSubscription
            account={account}
            plan={selectedPlan}
            onBack={backToPlans}
            onSubscribed={() => {
              setJustSubscribed(true);
              bump();
            }}
          />
        )}
      </main>

      {!IS_TRON_MAINNET_MODE && account && (
        <Suspense fallback={null}>
          <TronDevTools account={account} onChanged={bump} />
        </Suspense>
      )}
    </div>
  );
}

function App() {
  const [family, setFamily] = useState<NetworkFamily>("evm");

  return (
    <>
      <nav className="network-family-switch">
        <button className={family === "evm" ? "active" : ""} onClick={() => setFamily("evm")}>
          EVM
        </button>
        <button className={family === "tron" ? "active" : ""} onClick={() => setFamily("tron")}>
          TRON
        </button>
      </nav>
      {family === "evm" ? <EvmApp /> : <TronApp />}
    </>
  );
}

export default App;
