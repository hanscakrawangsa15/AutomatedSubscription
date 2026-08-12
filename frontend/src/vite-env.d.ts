/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Local Hardhat network identity */
  readonly VITE_LOCAL_CHAIN_ID?: string;
  readonly VITE_LOCAL_CHAIN_NAME?: string;
  readonly VITE_LOCAL_RPC_URL?: string;
  /** WalletConnect/Reown Cloud project ID — required for the wallet connect modal. Get one free at cloud.reown.com */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  /** Optional: base URL of the local notification server (default http://localhost:4000) */
  readonly VITE_NOTIFY_API_URL?: string;
  /** "testnet" (default) or "mainnet" — controls which chains SUPPORTED_CHAINS exposes and gates dev-only UI. See lib/chains.ts. */
  readonly VITE_NETWORK_MODE?: "testnet" | "mainnet";
  /** Paid RPC provider URLs, required only when VITE_NETWORK_MODE=mainnet */
  readonly VITE_BASE_MAINNET_RPC_URL?: string;
  readonly VITE_ETH_MAINNET_RPC_URL?: string;
  readonly VITE_BSC_MAINNET_RPC_URL?: string;
  // TRON — not chainId-keyed like the EVM vars below, since Tron networks
  // aren't identified that way. See lib/tronContracts.ts.
  /** "testnet" (default) or "mainnet" — independent from VITE_NETWORK_MODE (EVM), TRON has its own toggle. */
  readonly VITE_TRON_NETWORK_MODE?: "testnet" | "mainnet";
  readonly VITE_TRON_FULL_HOST?: string;
  readonly VITE_TRON_NILE_USDC_ADDRESS?: string;
  readonly VITE_TRON_NILE_MANAGER_ADDRESS?: string;
  readonly VITE_TRON_MAINNET_USDT_ADDRESS?: string;
  readonly VITE_TRON_MAINNET_MANAGER_ADDRESS?: string;
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
