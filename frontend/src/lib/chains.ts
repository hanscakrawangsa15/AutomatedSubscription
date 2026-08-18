import { defineChain } from "@reown/appkit/networks";
import { base, mainnet, bsc } from "@reown/appkit/networks";
import type { AppKitNetwork } from "@reown/appkit/networks";
import type { Chain } from "viem";

// viem's built-in chain definitions don't carry AppKit's required CAIP
// fields (chainNamespace/caipNetworkId) — wrap them with those plus the RPC
// URL this app actually wants to use.
function withCaip(chain: Chain, rpcUrl: string) {
  return defineChain({
    ...chain,
    chainNamespace: "eip155",
    caipNetworkId: `eip155:${chain.id}`,
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

// Mainnet-only build: this app carries real money, so every chain requires
// its own paid RPC provider URL (Alchemy/Infura/QuickNode) — no silent
// fallback to an unreliable public endpoint. Fail loudly at startup instead
// of shipping a build that half-works.
function mainnetRpc(envVar: keyof ImportMetaEnv, label: string): string {
  const url = import.meta.env[envVar];
  if (url) return url;
  throw new Error(
    `${envVar} is not set in frontend/.env — a paid RPC provider URL is required for ${label} (see frontend/.env.example).`,
  );
}

// Base still has real deployed managers (USDC/WETH) from an earlier phase,
// kept live and untouched — but the app moved to a USDT-only, ERC-20
// (Ethereum) / BEP-20 (BNB Chain) payment model, so Base is no longer
// offered as a connectable network. BASE_MAINNET stays exported (chain
// utilities below still recognize chain 8453) in case a wallet somehow
// ends up there, just excluded from SUPPORTED_CHAINS.
export const BASE_MAINNET = withCaip(base, mainnetRpc("VITE_BASE_MAINNET_RPC_URL", "Base"));
export const ETH_MAINNET = withCaip(mainnet, mainnetRpc("VITE_ETH_MAINNET_RPC_URL", "Ethereum Mainnet"));
export const BSC_MAINNET = withCaip(bsc, mainnetRpc("VITE_BSC_MAINNET_RPC_URL", "BNB Chain"));

/** Every network the app is willing to let a wallet connect/switch to. */
export const SUPPORTED_CHAINS: [AppKitNetwork, ...AppKitNetwork[]] = [ETH_MAINNET, BSC_MAINNET];

/** Sensible default network for AppKit/read-only UI before a wallet connects. */
export const DEFAULT_CHAIN: AppKitNetwork = SUPPORTED_CHAINS[0];

const MAINNET_CHAIN_IDS = new Set([8453, 1, 56]);

/** True for a real-money chain ID — every chain in this build is one. */
export function isMainnetChain(chainId: number | bigint | null | undefined): boolean {
  return chainId !== null && chainId !== undefined && MAINNET_CHAIN_IDS.has(Number(chainId));
}

export function getChainName(chainId: number | bigint | null | undefined): string {
  if (chainId === null || chainId === undefined) return "Unknown network";
  const match = SUPPORTED_CHAINS.find((c) => Number(c.id) === Number(chainId));
  return match?.name ?? `Chain ${chainId}`;
}

// Matches the `chain_name` slugs the `subscribers` MySQL table (and
// scripts/keeper.js's CHAIN_NAMES) expect — keep these three in sync.
const CHAIN_SLUGS: Record<number, string> = { 8453: "base-mainnet", 1: "ethereum-mainnet", 56: "bnb-mainnet" };

export function getChainSlug(chainId: number | bigint | null | undefined): string {
  if (chainId === null || chainId === undefined) return "unknown";
  return CHAIN_SLUGS[Number(chainId)] ?? `evm-${Number(chainId)}`;
}
