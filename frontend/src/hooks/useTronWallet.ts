import { useEffect, useState } from "react";
import { useWallet } from "@tronweb3/tronwallet-adapter-react-hooks";
import { TronLinkAdapterName } from "@tronweb3/tronwallet-adapters";

/**
 * Adapts @tronweb3/tronwallet-adapter-react-hooks' useWallet() to the same
 * shape as useAppKitWallet.ts (account/connecting/error/connect/disconnect)
 * for symmetry with the EVM flow — but there's no signer/provider/chainId
 * here. Contract calls go through window.tronWeb directly (see
 * lib/tronContracts.ts); this hook only tracks connect/disconnect state.
 * Must be used within the <WalletProvider> wrapping the app (see main.tsx).
 */
export function useTronWallet() {
  const { address, connected, connecting: adapterConnecting, select, disconnect: adapterDisconnect } = useWallet();
  const [error, setError] = useState<string | null>(null);

  // select() only updates React state (name -> adapter is derived on the
  // *next* render) — calling the adapter's own connect() synchronously
  // right after select() reads a stale (null) adapter and throws
  // "WalletNotSelectedError" ("No wallet is selected"). The provider's own
  // autoConnect effect (on by default) picks up the newly-selected adapter
  // once it re-renders and connects it — so select() alone is enough here;
  // this mirrors the two-step select-then-connect pattern the library's
  // own docs show as separate user actions, collapsed into one button.
  const connect = () => {
    setError(null);
    try {
      select(TronLinkAdapterName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect TronLink");
    }
  };

  useEffect(() => {
    if (!connected) return;
    // The wallet-adapter's connect() alone doesn't reliably populate a
    // fully-usable window.tronWeb (lib/tronContracts.ts's contract calls
    // go through it directly) — TronLink itself warns in the console that
    // dApps should call tron_requestAccounts to get "a complete TronWeb
    // injection." Fired once connected, harmless if already granted.
    window.tronLink?.request({ method: "tron_requestAccounts" }).catch(() => {});
  }, [connected]);

  const disconnect = async () => {
    setError(null);
    try {
      await adapterDisconnect();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet didn't confirm disconnect");
    }
  };

  return {
    account: connected ? (address ?? null) : null,
    connecting: adapterConnecting,
    error,
    connect,
    disconnect,
  };
}
