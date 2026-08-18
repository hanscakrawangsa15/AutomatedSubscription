/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WalletConnect/Reown Cloud project ID — required for the wallet connect modal. Get one free at cloud.reown.com */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  /** Optional: base URL of the local notification server (default http://localhost:4000) */
  readonly VITE_NOTIFY_API_URL?: string;
  /** Paid RPC provider URLs — required, this build is mainnet-only. See lib/chains.ts. */
  readonly VITE_BASE_MAINNET_RPC_URL?: string;
  readonly VITE_ETH_MAINNET_RPC_URL?: string;
  readonly VITE_BSC_MAINNET_RPC_URL?: string;
  // Per-chain contract addresses: VITE_USDC_ADDRESS_<chainId> and
  // VITE_SUBSCRIPTION_MANAGER_ADDRESS_<chainId>. Accessed dynamically in
  // lib/contracts.ts, so they're covered by this index signature rather
  // than listed individually.
  readonly [key: `VITE_USDC_ADDRESS_${string}`]: string | undefined;
  readonly [key: `VITE_SUBSCRIPTION_MANAGER_ADDRESS_${string}`]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
