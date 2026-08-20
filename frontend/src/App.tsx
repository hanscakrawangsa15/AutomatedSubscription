import { useCallback, useEffect, useState } from "react";
import { useAppKitNetwork } from "@reown/appkit/react";
import "./App.css";
import { useAppKitWallet } from "./hooks/useAppKitWallet";
import { WalletBar } from "./components/WalletBar";
import { PricingTiers } from "./components/PricingTiers";
import { ConnectWalletStep } from "./components/ConnectWalletStep";
import { PaymentNetworkStep } from "./components/PaymentNetworkStep";
import { ConfirmSubscription } from "./components/ConfirmSubscription";
import { ManageSubscription } from "./components/ManageSubscription";
import { getSubscriptionManager, getPaymentMethods, isChainDeployed } from "./lib/contracts";
import { SUPPORTED_CHAINS, ETH_MAINNET, BSC_MAINNET, getChainName } from "./lib/chains";
import type { PlanInfo } from "./lib/plans";
import type { BillingCycle, PricingTier } from "./lib/pricingTiers";

const ACTIVE = 1;
const OVERDUE = 2;

const ANY_CHAIN_CONFIGURED = SUPPORTED_CHAINS.some((c) => isChainDeployed(Number(c.id)));

function App() {
  const { signer, account, chainId, connecting, reconnecting, error, connect, disconnect } = useAppKitWallet();
  const { switchNetwork } = useAppKitNetwork();
  const [refreshKey, setRefreshKey] = useState(0);
  // The user's *intent* (which tier + billing cycle) — chain-agnostic, since
  // every payment network carries the exact same USDT-priced plan set. The
  // actual network (and therefore the real on-chain PlanInfo) is chosen
  // afterward on the PaymentNetworkStep — see selectedPlan below.
  const [selectedTier, setSelectedTier] = useState<{ tierId: PricingTier["id"]; cycle: BillingCycle } | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<PlanInfo | null>(null);
  const [justSubscribed, setJustSubscribed] = useState(false);
  const [subStatus, setSubStatus] = useState<number | null>(null);
  // Which payment method (token) the account's active/overdue subscription
  // (if any) lives on — a chain can have more than one manager (legacy
  // USDC/WETH/WBNB deployments are still live, even though the app no
  // longer offers them for new subscriptions), so "subscribed" is checked
  // across all of them, not just USDT's.
  const [subTokenSuffix, setSubTokenSuffix] = useState("");

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  const wrongNetwork = chainId !== null && !isChainDeployed(chainId);

  useEffect(() => {
    if (!signer || !account || wrongNetwork || chainId === null) {
      setSubStatus(null);
      setSubTokenSuffix("");
      return;
    }

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

  const backToPlans = () => {
    setSelectedTier(null);
    setSelectedPlan(null);
    setJustSubscribed(false);
  };

  const backToNetworkChoice = () => {
    setSelectedPlan(null);
  };

  // Disconnecting (or the account changing under us) clears any in-progress
  // tier/plan selection — otherwise reconnecting with a different account
  // later would resume mid-flow with a stale, possibly-wrong-chain choice.
  useEffect(() => {
    if (!signer || !account) {
      setSelectedTier(null);
      setSelectedPlan(null);
      setJustSubscribed(false);
    }
  }, [signer, account]);

  // Wallet connection gates everything else — a first-time visitor (no
  // prior session) must connect before they can even see pricing, since
  // that's the only way to know whether they already have a subscription.
  // Returning subscribers never notice this gate in practice: AppKit
  // silently restores their session on load (surfaced here as
  // `reconnecting`), so by the time this renders they're already
  // `signer && account` and land straight on Manage Subscription via the
  // hasSubscription check below.
  const currentStep = !selectedTier ? 1 : 2;

  return (
    <>
      <nav className="network-family-switch">
        <a className="back-link" href="https://xenorize.com/account?tab=subscription">
          &larr; Back to Dashboard
        </a>
      </nav>
      <div className="app">
        <WalletBar
          account={account}
          chainId={chainId}
          onDisconnect={disconnect}
          onConnect={connect}
          connecting={connecting}
        />

        {!ANY_CHAIN_CONFIGURED && (
          <div className="banner banner--warning">
            SubscriptionManager hasn't been deployed to Ethereum Mainnet or BNB Chain yet — see{" "}
            <code>docs/mainnet-addresses.md</code> and the mainnet-readiness plan for what's needed before a
            real deploy. Once deployed, add the printed <code>VITE_USDC_ADDRESS_&lt;chainId&gt;</code> /{" "}
            <code>VITE_SUBSCRIPTION_MANAGER_ADDRESS_&lt;chainId&gt;</code> pair to <code>frontend/.env</code>.
          </div>
        )}

        {signer && account && wrongNetwork && (
          <div className="banner banner--warning">
            Your wallet is connected to <strong>{getChainName(chainId)}</strong>, which this page doesn't support.
            If you've already subscribed, switch to the network you paid on — this page can only check your
            subscription on a supported network.
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={() => switchNetwork(ETH_MAINNET)}>Switch to Ethereum</button>
              <button onClick={() => switchNetwork(BSC_MAINNET)}>Switch to BNB Chain</button>
            </div>
          </div>
        )}

        {!hasSubscription && (
          <ol className="checkout-progress">
            <li className={currentStep === 1 ? "active" : currentStep > 1 ? "done" : ""}>Choose plan</li>
            <li className={currentStep === 2 ? "active" : ""}>Confirm</li>
          </ol>
        )}

        <main className="checkout">
          {!signer || !account ? (
            reconnecting ? (
              <section className="checkout-step">
                <p className="muted">Reconnecting your wallet...</p>
              </section>
            ) : (
              <ConnectWalletStep
                connecting={connecting}
                error={error}
                onConnect={connect}
                description="Connect your wallet to see pricing and check whether you already have an active subscription."
              />
            )
          ) : hasSubscription && chainId !== null ? (
            <ManageSubscription
              signer={signer}
              account={account}
              chainId={chainId}
              tokenSuffix={subTokenSuffix}
              refreshKey={refreshKey}
              onChanged={bump}
              justSubscribed={justSubscribed}
            />
          ) : !selectedTier ? (
            <PricingTiers
              refreshKey={refreshKey}
              onSelect={(_plan, tierId, cycle) => setSelectedTier({ tierId, cycle })}
            />
          ) : !selectedPlan ? (
            <PaymentNetworkStep
              tierId={selectedTier.tierId}
              cycle={selectedTier.cycle}
              chainId={chainId}
              onResolved={setSelectedPlan}
              onBack={backToPlans}
            />
          ) : (
            <ConfirmSubscription
              signer={signer}
              account={account}
              chainId={selectedPlan.chainId}
              plan={selectedPlan}
              onBack={backToNetworkChoice}
              onSubscribed={() => {
                setJustSubscribed(true);
                bump();
              }}
            />
          )}
        </main>
      </div>
    </>
  );
}

export default App;
