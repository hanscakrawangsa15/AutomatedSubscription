import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { PhantomWalletName } from "@solana/wallet-adapter-phantom";

/**
 * Adapts @solana/wallet-adapter-react's useWallet() to the same shape as
 * useAppKitWallet.ts (account/connecting/error/connect/disconnect) for
 * symmetry across chain families. No signer/provider here either — contract
 * calls go through lib/solanaProgram.ts's shared Program instance for
 * instruction-building, then this hook's own sendTransaction (exposed via
 * useWallet()) for actually signing/sending. Must be used within the
 * <WalletProvider autoConnect> wrapping the app (see main.tsx) —
 * autoConnect is what makes select() alone (below) sufficient to complete a
 * connection.
 */
export function useSolanaWallet() {
  const {
    publicKey,
    connected,
    connecting: adapterConnecting,
    select,
    wallets,
    disconnect: adapterDisconnect,
    sendTransaction,
  } = useWallet();
  const [error, setError] = useState<string | null>(null);

  const connect = () => {
    setError(null);
    // select() alone fails *silently* (no throw, no popup, nothing) when
    // the Phantom extension isn't installed — WalletReadyState stays
    // NotDetected and the provider's autoConnect effect just skips
    // connecting, with no feedback to the user at all. Check first and
    // surface a clear message instead of leaving the button looking broken.
    const phantom = wallets.find((w) => w.adapter.name === PhantomWalletName);
    if (!phantom || phantom.readyState === WalletReadyState.NotDetected || phantom.readyState === WalletReadyState.Unsupported) {
      setError("Phantom isn't installed in this browser. Install it from phantom.app, then reload and try again.");
      return;
    }
    try {
      select(PhantomWalletName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect Phantom");
    }
  };

  const disconnect = async () => {
    setError(null);
    try {
      await adapterDisconnect();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet didn't confirm disconnect");
    }
  };

  return {
    account: connected ? (publicKey?.toBase58() ?? null) : null,
    publicKey: connected ? publicKey : null,
    connecting: adapterConnecting,
    error,
    connect,
    disconnect,
    sendTransaction,
  };
}
