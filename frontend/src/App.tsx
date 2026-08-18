import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { useAppKitWallet } from "./hooks/useAppKitWallet";
import { WalletBar } from "./components/WalletBar";
import { PricingTiers } from "./components/PricingTiers";
import { ConnectWalletStep } from "./components/ConnectWalletStep";
import { ConfirmSubscription } from "./components/ConfirmSubscription";
import { ManageSubscription } from "./components/ManageSubscription";
import { WrongNetworkBanner } from "./components/WrongNetworkBanner";
import { SolanaPlanPicker } from "./components/SolanaPlanPicker";
import { SolanaConfirmSubscription } from "./components/SolanaConfirmSubscription";
import { SolanaManageSubscription } from "./components/SolanaManageSubscription";
import { getSubscriptionManager, getPaymentMethods, isChainDeployed } from "./lib/contracts";
import {
  getProgram as getSolanaProgram,
  getSolanaAddresses,
  isSolanaConfigured,
  solanaStatusToNumber,
  subscriptionPda,
  IS_SOLANA_MAINNET_MODE,
} from "./lib/solanaProgram";
import { useSolanaWallet } from "./hooks/useSolanaWallet";
import { SUPPORTED_CHAINS, DEFAULT_CHAIN, getChainName } from "./lib/chains";
import { fetchPlans, type PlanInfo } from "./lib/plans";
import { getReadProvider } from "./lib/readProvider";
import { PRICING_TIERS, findOnChainPlan, type BillingCycle, type PricingTier } from "./lib/pricingTiers";
import type { SolanaPlanInfo } from "./lib/solanaPlans";

const ACTIVE = 1;
const OVERDUE = 2;

const ANY_CHAIN_CONFIGURED = SUPPORTED_CHAINS.some((c) => isChainDeployed(Number(c.id)));

type NetworkFamily = "evm" | "solana";

function EvmApp() {
  const { signer, account, chainId, connecting, error, connect, disconnect } = useAppKitWallet();
  const [refreshKey, setRefreshKey] = useState(0);
  // The user's *intent* (which tier + billing cycle) is tracked separately
  // from `selectedPlan` (the actual on-chain PlanInfo it resolves to on the
  // current chain) — see the re-resolution effect below. This is what lets
  // a plan picked before connecting (or on one chain) survive a network
  // switch instead of being silently discarded.
  const [selectedTier, setSelectedTier] = useState<{
    tierId: PricingTier["id"];
    cycle: BillingCycle;
    tokenSuffix: string;
  } | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<PlanInfo | null>(null);
  const [planResolutionError, setPlanResolutionError] = useState<string | null>(null);
  const [justSubscribed, setJustSubscribed] = useState(false);
  const [subStatus, setSubStatus] = useState<number | null>(null);
  // Which payment method (token) the account's active/overdue subscription
  // (if any) lives on — a chain can now have more than one manager, so
  // "subscribed" is no longer a single-manager question. "" = primary.
  const [subTokenSuffix, setSubTokenSuffix] = useState("");

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Before a wallet connects (or if it's on an unconfigured chain), default
  // to showing pricing for this build's first supported chain rather than
  // nothing.
  const readChainId = chainId ?? BigInt(DEFAULT_CHAIN.id);
  const wrongNetwork = chainId !== null && !isChainDeployed(chainId);

  useEffect(() => {
    if (!signer || !account || wrongNetwork || chainId === null) {
      setSubStatus(null);
      setSubTokenSuffix("");
      return;
    }

    // A subscription can now live on any of the chain's manager instances
    // (one per payment method) — check them all and resolve to whichever
    // one is actually Active/Overdue, instead of only ever looking at the
    // primary token's manager.
    let cancelled = false;
    const methods = getPaymentMethods(chainId);
    Promise.all(
      methods.map((m) =>
        getSubscriptionManager(signer, chainId, m.suffix)
          .subscriptions(account)
          .then((sub: { status: bigint }) => ({ suffix: m.suffix, status: Number(sub.status) }))
          .catch(() => ({ suffix: m.suffix, status: 0 })),
      ),
    ).then((results) => {
      if (cancelled) return;
      const active = results.find((r) => r.status === ACTIVE || r.status === OVERDUE);
      setSubStatus(active?.status ?? results[0]?.status ?? null);
      setSubTokenSuffix(active?.suffix ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [signer, account, chainId, refreshKey, wrongNetwork]);

  const hasSubscription = subStatus === ACTIVE || subStatus === OVERDUE;

  // A tier picked before connecting (shown for the preview chain) or on a
  // different network needs its *actual on-chain plan* re-resolved for
  // whichever chain is active now — plan IDs/addresses aren't shared across
  // deployments, so the previously-resolved PlanInfo would be stale. This
  // re-fetches and re-matches by (tier, cycle) instead of silently
  // discarding the user's choice and bouncing them back to "Choose plan"
  // with no explanation (the previous behavior).
  useEffect(() => {
    if (!selectedTier) {
      setSelectedPlan(null);
      setPlanResolutionError(null);
      return;
    }
    const provider = getReadProvider(readChainId);
    if (!provider) {
      setSelectedPlan(null);
      return;
    }
    let cancelled = false;
    fetchPlans(provider, readChainId, selectedTier.tokenSuffix)
      .then((plans) => {
        if (cancelled) return;
        const tier = PRICING_TIERS.find((t) => t.id === selectedTier.tierId);
        const match = tier ? findOnChainPlan(plans, tier, selectedTier.cycle) : undefined;
        if (match) {
          setSelectedPlan(match);
          setPlanResolutionError(null);
        } else {
          setSelectedPlan(null);
          setPlanResolutionError(
            `The ${tier?.name ?? "selected"} plan isn't available in that token on ${getChainName(readChainId)} yet — pick a plan for this network.`,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setSelectedPlan(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTier, readChainId]);

  const backToPlans = () => {
    setSelectedTier(null);
    setSelectedPlan(null);
    setPlanResolutionError(null);
    setJustSubscribed(false);
  };

  const currentStep = hasSubscription ? 3 : !selectedPlan ? 1 : !signer || !account ? 2 : 3;

  return (
    <div className="app">
      <WalletBar account={account} chainId={chainId} onDisconnect={disconnect} />
      {planResolutionError && <p className="error">{planResolutionError}</p>}

      {!ANY_CHAIN_CONFIGURED && (
        <div className="banner banner--warning">
          SubscriptionManager hasn't been deployed to Base, Ethereum Mainnet, or BNB Chain yet — see{" "}
          <code>docs/mainnet-addresses.md</code> and the mainnet-readiness plan for what's needed before a
          real deploy. Once deployed, add the printed <code>VITE_USDC_ADDRESS_&lt;chainId&gt;</code> /{" "}
          <code>VITE_SUBSCRIPTION_MANAGER_ADDRESS_&lt;chainId&gt;</code> pair to <code>frontend/.env</code>.
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
            tokenSuffix={subTokenSuffix}
            refreshKey={refreshKey}
            onChanged={bump}
            justSubscribed={justSubscribed}
          />
        ) : !selectedPlan ? (
          <PricingTiers
            chainId={readChainId}
            refreshKey={refreshKey}
            onSelect={(plan, tierId, cycle) => {
              setSelectedTier({ tierId, cycle, tokenSuffix: plan.tokenSuffix });
              setSelectedPlan(plan);
            }}
          />
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
    </div>
  );
}

function SolanaApp() {
  const { account, publicKey, connecting, error, connect, disconnect } = useSolanaWallet();
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedPlan, setSelectedPlan] = useState<SolanaPlanInfo | null>(null);
  const [justSubscribed, setJustSubscribed] = useState(false);
  const [subStatus, setSubStatus] = useState<number | null>(null);
  const deployed = isSolanaConfigured();

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!publicKey || !deployed) {
      setSubStatus(null);
      return;
    }
    const program = getSolanaProgram();
    const addrs = getSolanaAddresses();
    if (!program || !addrs) {
      setSubStatus(null);
      return;
    }
    const pda = subscriptionPda(addrs.config, publicKey, addrs.programId);
    program.account.subscription
      .fetch(pda)
      .then((sub) => setSubStatus(solanaStatusToNumber(sub.status as Record<string, unknown>)))
      // Fresh wallet with no Subscription PDA yet — fetch rejects with
      // "Account does not exist", which just means "not subscribed."
      .catch(() => setSubStatus(null));
  }, [publicKey, deployed, refreshKey]);

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
          <h1>Subscription Plan</h1>
          <span className={`mode-badge ${IS_SOLANA_MAINNET_MODE ? "mode-badge--mainnet" : "mode-badge--testnet"}`}>
            {IS_SOLANA_MAINNET_MODE ? "Solana Mainnet · real funds" : "Solana Devnet"}
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

      {!deployed && (
        <div className="banner banner--warning">
          Solana {IS_SOLANA_MAINNET_MODE ? "Mainnet" : "Devnet"} isn't deployed yet. See the Solana
          integration plan, then add the printed{" "}
          <code>VITE_SOLANA_{IS_SOLANA_MAINNET_MODE ? "MAINNET" : "DEVNET"}_*</code> vars to{" "}
          <code>frontend/.env</code>.
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
          <SolanaManageSubscription refreshKey={refreshKey} onChanged={bump} justSubscribed={justSubscribed} />
        ) : !selectedPlan ? (
          <SolanaPlanPicker refreshKey={refreshKey} onSelect={setSelectedPlan} />
        ) : !account ? (
          <>
            <ConnectWalletStep
              connecting={connecting}
              error={error}
              onConnect={connect}
              description={`Connect Phantom to subscribe on Solana ${IS_SOLANA_MAINNET_MODE ? "Mainnet" : "Devnet"}.`}
              connectingLabel="Opening Phantom..."
              connectLabel="Connect Phantom"
            />
            <button className="link-button" onClick={backToPlans}>
              &larr; Back to plans
            </button>
          </>
        ) : (
          <SolanaConfirmSubscription
            plan={selectedPlan}
            onBack={backToPlans}
            onSubscribed={() => {
              setJustSubscribed(true);
              bump();
            }}
          />
        )}
      </main>
    </div>
  );
}

function App() {
  const [family, setFamily] = useState<NetworkFamily>("evm");

  return (
    <>
      <nav className="network-family-switch">
        <div className="network-family-switch__tabs">
          <button className={family === "evm" ? "active" : ""} onClick={() => setFamily("evm")}>
            EVM
          </button>
          <button className={family === "solana" ? "active" : ""} onClick={() => setFamily("solana")}>
            SOLANA
          </button>
        </div>
        <a className="back-link" href="https://xenorize.com/account?tab=subscription">
          &larr; Back
        </a>
      </nav>
      {family === "evm" ? <EvmApp /> : <SolanaApp />}
    </>
  );
}

export default App;
