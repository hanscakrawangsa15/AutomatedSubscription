import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";

const SOLANA_MODE = import.meta.env.VITE_SOLANA_NETWORK_MODE === "devnet" ? "devnet" : "mainnet";
const SOLANA_RPC_URL =
  (SOLANA_MODE === "mainnet" ? import.meta.env.VITE_SOLANA_MAINNET_RPC_URL : import.meta.env.VITE_SOLANA_DEVNET_RPC_URL) ||
  (SOLANA_MODE === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");

// Second, independent wallet ecosystem alongside AppKit (EVM) — same
// additive philosophy in main.tsx, no chain family's setup touches the
// other's.
export function SolanaProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={SOLANA_RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect onError={(err) => console.error("[Phantom]", err)}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
