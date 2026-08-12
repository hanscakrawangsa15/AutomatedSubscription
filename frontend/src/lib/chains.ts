import { defineChain } from "@reown/appkit/networks";
import { baseSepolia, sepolia, bscTestnet, base, mainnet, bsc } from "@reown/appkit/networks";
import type { AppKitNetwork } from "@reown/appkit/networks";
import type { Chain } from "viem";

const LOCAL_CHAIN_ID = Number(import.meta.env.VITE_LOCAL_CHAIN_ID || 31337);
const LOCAL_CHAIN_NAME = import.meta.env.VITE_LOCAL_CHAIN_NAME || "Hardhat Local";
const LOCAL_RPC_URL = import.meta.env.VITE_LOCAL_RPC_URL || "http://127.0.0.1:8545";

export const LOCAL_CHAIN = defineChain({
  id: LOCAL_CHAIN_ID,
  chainNamespace: "eip155",
  caipNetworkId: `eip155:${LOCAL_CHAIN_ID}`,
  name: LOCAL_CHAIN_NAME,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [LOCAL_RPC_URL] },
  },
  testnet: true,
});

// viem's built-in chain definitions don't carry AppKit's required CAIP
// fields (chainNamespace/caipNetworkId) — wrap them the same way as the
// custom local chain above. Also override the RPC with the same endpoints
// hardhat.config.js/deploy scripts already use — viem's own defaults for
// some of these (e.g. BSC Testnet's data-seed-prebsc-1-s1.bnbchain.org) are
// heavily rate-limited and were causing eth_getLogs failures in the wallet.
function withCaip(chain: Chain, rpcUrl: string) {
  return defineChain({
    ...chain,
    chainNamespace: "eip155",
    caipNetworkId: `eip155:${chain.id}`,
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export const BASE_SEPOLIA = withCaip(baseSepolia, "https://sepolia.base.org");
export const ETH_SEPOLIA = withCaip(sepolia, "https://ethereum-sepolia-rpc.publicnode.com");
export const BSC_TESTNET = withCaip(bscTestnet, "https://bsc-testnet-rpc.publicnode.com");

const NETWORK_MODE = (import.meta.env.VITE_NETWORK_MODE || "testnet") as "testnet" | "mainnet";

/** True when this build is configured to only expose real-money mainnet chains. */
export const IS_MAINNET_MODE = NETWORK_MODE === "mainnet";

// Mainnet chains require a paid RPC provider (Alchemy/Infura/QuickNode) —
// no public-endpoint fallback in a real production mainnet build, unlike
// the testnets above. A silent fallback to a free public RPC is exactly
// the reliability problem this project already hit on testnet (block-range
// caps, batch-rejected eth_getLogs), except with real money and real user
// load behind it. Fail loudly at startup instead of shipping a build that
// half-works.
//
// In `vite`/`npm run dev` (import.meta.env.DEV), this is relaxed: use the
// paid URL if it's already configured in .env, but fall back to a public
// RPC instead of throwing — dev mode shows every chain (testnet + mainnet)
// together for one-click switching (see SUPPORTED_CHAINS below), and
// shouldn't hard-fail to start just because mainnet RPCs aren't set up yet
// while someone is only testing testnet chains.
function mainnetRpc(envVar: keyof ImportMetaEnv, label: string, publicFallback: string): string {
  const url = import.meta.env[envVar];
  if (url) return url;
  if (IS_MAINNET_MODE && !import.meta.env.DEV) {
    throw new Error(
      `${envVar} is not set in frontend/.env — a paid RPC provider URL is required for ${label} in a mainnet ` +
        `production build (see frontend/.env.example). Public RPC endpoints are not used for mainnet chains.`,
    );
  }
  return publicFallback;
}

export const BASE_MAINNET = withCaip(base, mainnetRpc("VITE_BASE_MAINNET_RPC_URL", "Base", "https://mainnet.base.org"));
export const ETH_MAINNET = withCaip(
  mainnet,
  mainnetRpc("VITE_ETH_MAINNET_RPC_URL", "Ethereum Mainnet", "https://eth.llamarpc.com"),
);
export const BSC_MAINNET = withCaip(bsc, mainnetRpc("VITE_BSC_MAINNET_RPC_URL", "BNB Chain", "https://bsc-dataseed.binance.org"));

const TESTNET_CHAINS: [AppKitNetwork, ...AppKitNetwork[]] = [LOCAL_CHAIN, BASE_SEPOLIA, ETH_SEPOLIA, BSC_TESTNET];
const MAINNET_CHAINS: [AppKitNetwork, ...AppKitNetwork[]] = [BASE_MAINNET, ETH_MAINNET, BSC_MAINNET];

/**
 * Every network the app is willing to let a wallet connect/switch to.
 *
 * In dev (`npm run dev`), this is every chain — testnet and mainnet
 * together — so switching between them is one click in the wallet's own
 * network selector, no server restart needed. Dev-only UI (DevTools, mode
 * badge) still reacts correctly per chain via isMainnetChain(chainId), not
 * a single global flag, so the right thing happens no matter which chain
 * you're actually connected to.
 *
 * A real production build (`vite build`) still respects VITE_NETWORK_MODE
 * and only ships ONE set — a shipped mainnet build never carries testnet
 * chains/code and vice versa. That separation is the actual security
 * property; the dev convenience above doesn't weaken it.
 */
export const SUPPORTED_CHAINS: [AppKitNetwork, ...AppKitNetwork[]] = import.meta.env.DEV
  ? [...TESTNET_CHAINS, ...MAINNET_CHAINS]
  : IS_MAINNET_MODE
    ? MAINNET_CHAINS
    : TESTNET_CHAINS;

/** Sensible default network for AppKit/read-only UI before a wallet connects. */
export const DEFAULT_CHAIN: AppKitNetwork = SUPPORTED_CHAINS[0];

export function isLocalChain(chainId: number | bigint | null | undefined): boolean {
  return chainId !== null && chainId !== undefined && Number(chainId) === LOCAL_CHAIN_ID;
}

const MAINNET_CHAIN_IDS = new Set([8453, 1, 56]);

/**
 * True for a real-money chain ID regardless of build mode — used to gate
 * dev-only UI (e.g. DevTools) at runtime as a second layer of defense on
 * top of IS_MAINNET_MODE, in case a testnet-mode build's wallet is ever
 * switched to a mainnet chain manually.
 */
export function isMainnetChain(chainId: number | bigint | null | undefined): boolean {
  return chainId !== null && chainId !== undefined && MAINNET_CHAIN_IDS.has(Number(chainId));
}

export function getChainName(chainId: number | bigint | null | undefined): string {
  if (chainId === null || chainId === undefined) return "Unknown network";
  const match = SUPPORTED_CHAINS.find((c) => Number(c.id) === Number(chainId));
  return match?.name ?? `Chain ${chainId}`;
}

// Pairs each testnet with the mainnet chain of the same underlying network
// (Base Sepolia <-> Base, etc.), so a Testnet/Mainnet toggle can switch a
// connected wallet to "the same chain family, other mode" with one click,
// rather than an arbitrary pick from all 6. Hardhat Local has no mainnet
// counterpart, so it isn't a key here — see getCorrespondingChain's default.
const TESTNET_TO_MAINNET: Record<number, AppKitNetwork> = {
  [BASE_SEPOLIA.id]: BASE_MAINNET,
  [ETH_SEPOLIA.id]: ETH_MAINNET,
  [BSC_TESTNET.id]: BSC_MAINNET,
};
const MAINNET_TO_TESTNET: Record<number, AppKitNetwork> = {
  [BASE_MAINNET.id]: BASE_SEPOLIA,
  [ETH_MAINNET.id]: ETH_SEPOLIA,
  [BSC_MAINNET.id]: BSC_TESTNET,
};

/**
 * The chain to switch to for a Testnet/Mainnet toggle: same chain family as
 * `chainId` if there's a direct pairing (e.g. currently on Sepolia, target
 * "mainnet" -> Ethereum Mainnet); otherwise falls back to Base (Sepolia or
 * mainnet) as a reasonable default — covers Hardhat Local, being
 * disconnected, or already being on an unrecognized chain.
 */
export function getCorrespondingChain(
  chainId: number | bigint | null | undefined,
  targetMode: "testnet" | "mainnet",
): AppKitNetwork {
  const id = chainId !== null && chainId !== undefined ? Number(chainId) : null;
  if (targetMode === "mainnet") {
    return (id !== null && TESTNET_TO_MAINNET[id]) || BASE_MAINNET;
  }
  return (id !== null && MAINNET_TO_TESTNET[id]) || BASE_SEPOLIA;
}
