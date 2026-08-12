import { TronWeb } from "tronweb";
import { SUBSCRIPTION_MANAGER_TRON_ABI } from "../abi/SubscriptionManagerTron";
import { MOCK_USDC_TRON_ABI } from "../abi/MockUSDCTron";

// "testnet" (default) or "mainnet" — separate from the EVM side's
// VITE_NETWORK_MODE since TRON and EVM are independent ecosystems in this
// app (you can e.g. still be testing TRON while EVM is already live). Same
// build-time-flag pattern as chains.ts's IS_MAINNET_MODE.
const TRON_NETWORK_MODE = (import.meta.env.VITE_TRON_NETWORK_MODE || "testnet") as "testnet" | "mainnet";
export const IS_TRON_MAINNET_MODE = TRON_NETWORK_MODE === "mainnet";

const DEFAULT_FULL_HOST = IS_TRON_MAINNET_MODE ? "https://api.trongrid.io" : "https://nile.trongrid.io";
const FULL_HOST = import.meta.env.VITE_TRON_FULL_HOST || DEFAULT_FULL_HOST;

// TronWeb requires an owner_address to be set on the instance even for
// pure read-only `.call()`s (it's sent as the "from" context) — this is
// TRON's null/burn address (hex 41 + 20 zero bytes), used only as a
// placeholder for reads. Never used to sign or send anything.
const NULL_ADDRESS = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

// window.tronWeb / window.tronLink are already declared globally by
// @tronweb3/tronwallet-adapter-tronlink (a transitive dep of
// @tronweb3/tronwallet-adapters) — reusing that ambient type here instead
// of redeclaring it, which TypeScript rejects as a conflicting duplicate.

// Per TronLink's own docs (docs.tronlink.org/reference/networks) — the
// chainId wallet_switchEthereumChain (TIP-3326) expects per network.
const MAINNET_CHAIN_ID_HEX = "0x2b6653dc";
const NILE_CHAIN_ID_HEX = "0xcd8690dc";

// Lets the app ask TronLink to switch itself to the right network, instead
// of making the user hunt for the right menu — TronLink defaults to
// Mainnet and the network selector isn't in an obvious place in every
// version of the extension. Requires the target network already exist in
// TronLink (both are built in) — this doesn't add a custom network.
export async function switchToTronNetwork(): Promise<void> {
  if (!window.tronLink) throw new Error("TronLink isn't installed.");
  await window.tronLink.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: IS_TRON_MAINNET_MODE ? MAINNET_CHAIN_ID_HEX : NILE_CHAIN_ID_HEX }],
  });
}

// Unlike the EVM side (lib/contracts.ts), addresses here are not keyed by
// numeric chainId — TRON networks aren't identified that way. Testnet vs
// mainnet is a separate pair of env vars, picked by VITE_TRON_NETWORK_MODE
// above (mirrors chains.ts's IS_MAINNET_MODE branching for EVM).
export function getTronAddresses(): { usdc: string; manager: string } | null {
  const usdc = IS_TRON_MAINNET_MODE
    ? import.meta.env.VITE_TRON_MAINNET_USDT_ADDRESS
    : import.meta.env.VITE_TRON_NILE_USDC_ADDRESS;
  const manager = IS_TRON_MAINNET_MODE
    ? import.meta.env.VITE_TRON_MAINNET_MANAGER_ADDRESS
    : import.meta.env.VITE_TRON_NILE_MANAGER_ADDRESS;
  if (!usdc || !manager) return null;
  return { usdc, manager };
}

export function isTronConfigured(): boolean {
  return getTronAddresses() !== null;
}

// Contract calls deliberately go through window.tronWeb (TronLink's own
// injected, already-signing-capable instance) rather than the wallet
// adapter's lower-level signTransaction API — TronLink's injected
// `contract(...).send()` already builds, signs (via its confirmation
// popup), and broadcasts in one call, mirroring how the EVM side gets a
// ready-to-use ethers Signer from the browser wallet. The wallet adapter
// (useTronWallet.ts) is used only for connect/disconnect lifecycle state.
//
// TronLink lets the user pick a network independently of this app (unlike
// AppKit, which drives the EVM wallet's network via SUPPORTED_CHAINS).
// There's no reliable way to pre-flight-check which network TronLink is on
// from the page (window.tronWeb.fullNode.host doesn't consistently match
// the RPC URL shown in TronLink's own UI, e.g. when it proxies through a
// gateway) — so instead of guessing, a wrong-network call is left to fail
// naturally and translated where the error surfaces (see lib/errors.ts's
// handling of TronWeb's "Smart contract is not exist").
function getInjectedTronWeb() {
  // window.tronWeb isn't always the fully-populated instance right after
  // connecting (TronLink itself warns dApps need tron_requestAccounts for
  // "a complete TronWeb injection" — see useTronWallet.ts) — fall back to
  // window.tronLink.tronWeb, which TronLink also exposes.
  const tronWeb = window.tronWeb?.ready ? window.tronWeb : window.tronLink?.ready ? window.tronLink.tronWeb : null;
  if (!tronWeb) {
    throw new Error("TronLink isn't connected. Connect your wallet first.");
  }
  return tronWeb;
}

export function getTronUsdc() {
  const addrs = getTronAddresses();
  if (!addrs) {
    throw new Error(
      IS_TRON_MAINNET_MODE
        ? "TRON Mainnet USDT isn't configured (check frontend/.env for VITE_TRON_MAINNET_USDT_ADDRESS/VITE_TRON_MAINNET_MANAGER_ADDRESS)"
        : "Tron USDT isn't configured (check frontend/.env for VITE_TRON_NILE_USDC_ADDRESS)",
    );
  }
  // Real mainnet USDT is a plain TRC20 (no mint()) — the ABI here (built
  // from our own MockUSDC.sol) still works for it since TronWeb only needs
  // entries for the methods actually called (balanceOf/decimals/allowance/
  // approve), all standard TRC20/ERC20 surface. mint() is simply never
  // invoked in mainnet mode (see App.tsx's DevTools gating).
  return getInjectedTronWeb().contract(MOCK_USDC_TRON_ABI, addrs.usdc);
}

export function getTronSubscriptionManager() {
  const addrs = getTronAddresses();
  if (!addrs) {
    throw new Error(
      IS_TRON_MAINNET_MODE
        ? "TRON Mainnet SubscriptionManager isn't configured (not deployed yet — see docs/mainnet-addresses.md)"
        : "Tron SubscriptionManager isn't configured (check frontend/.env for VITE_TRON_NILE_MANAGER_ADDRESS)",
    );
  }
  return getInjectedTronWeb().contract(SUBSCRIPTION_MANAGER_TRON_ABI, addrs.manager);
}

// Read-only instance (no wallet needed) so plan pricing can be shown before
// TronLink is connected — mirrors lib/readProvider.ts's role on the EVM
// side. Reads that need the connected account (allowance/balance) still go
// through the injected instance above.
let readTronWeb: InstanceType<typeof TronWeb> | null = null;
function getReadTronWeb() {
  if (!readTronWeb) {
    readTronWeb = new TronWeb({ fullHost: FULL_HOST });
    readTronWeb.setAddress(NULL_ADDRESS);
  }
  return readTronWeb;
}

export function getTronUsdcRead() {
  const addrs = getTronAddresses();
  if (!addrs) return null;
  return getReadTronWeb().contract(MOCK_USDC_TRON_ABI, addrs.usdc);
}

export function getTronSubscriptionManagerRead() {
  const addrs = getTronAddresses();
  if (!addrs) return null;
  return getReadTronWeb().contract(SUBSCRIPTION_MANAGER_TRON_ABI, addrs.manager);
}
