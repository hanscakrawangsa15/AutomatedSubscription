import { useEffect, useState } from "react";
import { BrowserProvider, JsonRpcProvider, type Eip1193Provider, type JsonRpcSigner } from "ethers";
import { useAppKit, useAppKitAccount, useAppKitNetwork, useAppKitProvider, useDisconnect } from "@reown/appkit/react";
import { appKit } from "../lib/appkit";

// LOCAL DEMO MODE — never active in a production build. Only when the dev
// server is started with VITE_DEMO_ACCOUNT=<address> does the "wallet" become
// an unlocked account of a local Hardhat node (VITE_BSC_MAINNET_RPC_URL),
// which signs by itself — no extension, no keys in the code. Vite replaces
// import.meta.env.DEV with `false` in `vite build`, so this whole branch is
// dead code there.
export const DEMO_ACCOUNT: string | undefined = import.meta.env.DEV ? import.meta.env.VITE_DEMO_ACCOUNT : undefined;
const DEMO_CHAIN_ID = 56n;

function useDemoWallet() {
  const [signer, setSigner] = useState<JsonRpcSigner | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const rpc = new JsonRpcProvider(import.meta.env.VITE_BSC_MAINNET_RPC_URL, DEMO_CHAIN_ID, { staticNetwork: true });
      setSigner(await rpc.getSigner(DEMO_ACCOUNT));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demo node unreachable — is `hardhat node` running?");
    } finally {
      setConnecting(false);
    }
  };

  return {
    provider: null as BrowserProvider | null,
    signer,
    account: signer ? (DEMO_ACCOUNT ?? null) : null,
    chainId: signer ? DEMO_CHAIN_ID : null,
    connecting,
    reconnecting: false,
    error,
    connect,
    disconnect: async () => setSigner(null),
  };
}

/**
 * Adapts Reown AppKit's hooks to the same shape the app's components already
 * expect (provider/signer/account/chainId/connect/disconnect), so the
 * WalletConnect modal (all wallets: injected, mobile via QR, Coinbase, etc.)
 * can be dropped in without touching the checkout/confirm/manage screens.
 */
function useRealWallet() {
  const { open } = useAppKit();
  const { address, isConnected, status } = useAppKitAccount();
  const { chainId: rawChainId } = useAppKitNetwork();
  const { walletProvider } = useAppKitProvider<Eip1193Provider>("eip155");
  const { disconnect: disconnectAppKit } = useDisconnect();

  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [signer, setSigner] = useState<JsonRpcSigner | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Some injected connectors don't cleanly support AppKit's disconnect call
  // (it can throw internally and leave isConnected/address unchanged). This
  // local override guarantees the UI still reflects "disconnected" even if
  // the underlying wallet session technically persists.
  const [locallyDisconnected, setLocallyDisconnected] = useState(false);

  useEffect(() => {
    if (!isConnected || !walletProvider || locallyDisconnected) {
      setProvider(null);
      setSigner(null);
      return;
    }
    let cancelled = false;
    const browserProvider = new BrowserProvider(walletProvider);
    setProvider(browserProvider);
    browserProvider
      .getSigner()
      .then((s) => {
        if (!cancelled) setSigner(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to get signer");
      });
    return () => {
      cancelled = true;
    };
    // rawChainId is intentionally included: AppKit reuses the same
    // walletProvider object across a network switch, so without this the
    // BrowserProvider/signer would stay bound to whatever chain was active
    // when they were first created — the next tx then fails with ethers'
    // "network changed" error once the wallet's actual chain has moved on.
  }, [isConnected, walletProvider, locallyDisconnected, rawChainId]);

  const connect = async () => {
    if (!appKit) {
      setError("VITE_WALLETCONNECT_PROJECT_ID is not set — see frontend/.env.example.");
      return;
    }
    setLocallyDisconnected(false);
    setConnecting(true);
    setError(null);
    try {
      await open();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open wallet modal");
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    setError(null);
    try {
      await disconnectAppKit();
    } catch (err) {
      console.error("AppKit disconnect failed, falling back to local disconnect:", err);
      setError(err instanceof Error ? err.message : "Wallet didn't confirm disconnect");
    } finally {
      setLocallyDisconnected(true);
    }
  };

  return {
    provider,
    signer,
    account: locallyDisconnected ? null : (address ?? null),
    chainId: locallyDisconnected ? null : rawChainId !== undefined ? BigInt(rawChainId) : null,
    connecting,
    // AppKit silently restores a previously-connected session (WalletConnect
    // pairing or an already-authorized injected wallet) on page load — this
    // exposes that in-progress restoration so the UI can show a quiet
    // loading state instead of flashing "Connect your wallet" at a returning
    // subscriber for the brief moment before their session comes back.
    reconnecting: !locallyDisconnected && (status === "reconnecting" || status === "connecting"),
    error,
    connect,
    disconnect,
  };
}

// DEMO_ACCOUNT is a module-level constant, so the same hook is chosen on every
// render and React's hook order stays stable.
export const useAppKitWallet = DEMO_ACCOUNT ? useDemoWallet : useRealWallet;
