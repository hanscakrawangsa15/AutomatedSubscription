import { useEffect, useState } from "react";
import { BrowserProvider, type Eip1193Provider, type JsonRpcSigner } from "ethers";
import { useAppKit, useAppKitAccount, useAppKitNetwork, useAppKitProvider, useDisconnect } from "@reown/appkit/react";
import { appKit } from "../lib/appkit";

/**
 * Adapts Reown AppKit's hooks to the same shape the app's components already
 * expect (provider/signer/account/chainId/connect/disconnect), so the
 * WalletConnect modal (all wallets: injected, mobile via QR, Coinbase, etc.)
 * can be dropped in without touching the checkout/confirm/manage screens.
 */
export function useAppKitWallet() {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();
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
    error,
    connect,
    disconnect,
  };
}
