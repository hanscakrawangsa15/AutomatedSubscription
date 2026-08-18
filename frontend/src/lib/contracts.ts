import { Contract, type Signer, type Provider } from "ethers";
import { MOCK_USDC_ABI } from "../abi/MockUSDC";
import { SUBSCRIPTION_MANAGER_ABI } from "../abi/SubscriptionManager";

export type ChainAddresses = { usdc: string; manager: string; suffix: string };

// A second payment token on a chain that already has one is a second
// SubscriptionManager instance (paymentToken is immutable — one token per
// instance). Its env vars reuse the existing VITE_*_ADDRESS_<chainId>
// convention with a token-symbol suffix appended (e.g. "_USDT"); the
// unsuffixed vars stay each chain's original/primary token, so every
// existing single-token chain is unaffected.
function readAddresses(chainId: number, suffix: string): ChainAddresses | null {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const usdc = env[`VITE_USDC_ADDRESS_${chainId}${suffix}`];
  const manager = env[`VITE_SUBSCRIPTION_MANAGER_ADDRESS_${chainId}${suffix}`];
  if (!usdc || !manager) return null;
  return { usdc, manager, suffix };
}

// Discovers which token suffixes are actually configured for a chain by
// scanning import.meta.env's keys at runtime, rather than a hardcoded
// registry — so adding a new token later only needs a .env change (plus a
// rebuild, since Vite inlines these at build time) and no source change.
// Object.keys() works here the same way the existing bracket-access above
// already does against a runtime chainId: Vite's client-env plugin injects
// import.meta.env as a real object, not just per-property text
// substitution.
function discoverSuffixes(chainId: number): string[] {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const prefix = `VITE_SUBSCRIPTION_MANAGER_ADDRESS_${chainId}`;
  const suffixes = new Set<string>();
  for (const key of Object.keys(env)) {
    if (key === prefix) suffixes.add("");
    else if (key.startsWith(`${prefix}_`)) suffixes.add(key.slice(prefix.length));
  }
  return [...suffixes];
}

const addressCache = new Map<string, ChainAddresses | null>();

export function getChainAddresses(
  chainId: number | bigint | null | undefined,
  suffix = "",
): ChainAddresses | null {
  if (chainId === null || chainId === undefined) return null;
  const id = Number(chainId);
  const key = `${id}${suffix}`;
  if (!addressCache.has(key)) addressCache.set(key, readAddresses(id, suffix));
  return addressCache.get(key) ?? null;
}

const methodsCache = new Map<number, ChainAddresses[]>();

// All payment methods (token/manager pairs) configured for a chain — "" is
// always first when present, so callers that just want "the" token for a
// chain (single-token chains, the vast majority today) can keep using
// getChainAddresses()/index [0] without change.
export function getPaymentMethods(chainId: number | bigint | null | undefined): ChainAddresses[] {
  if (chainId === null || chainId === undefined) return [];
  const id = Number(chainId);
  if (!methodsCache.has(id)) {
    const methods = discoverSuffixes(id)
      .map((suffix) => readAddresses(id, suffix))
      .filter((a): a is ChainAddresses => a !== null)
      .sort((a, b) => (a.suffix === "" ? -1 : b.suffix === "" ? 1 : a.suffix.localeCompare(b.suffix)));
    methodsCache.set(id, methods);
  }
  return methodsCache.get(id) ?? [];
}

export function isChainDeployed(chainId: number | bigint | null | undefined): boolean {
  return getPaymentMethods(chainId).length > 0;
}

export function getMockUsdc(runner: Signer | Provider, chainId: number | bigint, suffix = "") {
  const addrs = getChainAddresses(chainId, suffix);
  if (!addrs) throw new Error(`Payment token isn't configured for chain ${chainId}${suffix} (check frontend/.env)`);
  return new Contract(addrs.usdc, MOCK_USDC_ABI, runner);
}

export function getSubscriptionManager(runner: Signer | Provider, chainId: number | bigint, suffix = "") {
  const addrs = getChainAddresses(chainId, suffix);
  if (!addrs) {
    throw new Error(`SubscriptionManager isn't configured for chain ${chainId}${suffix} (check frontend/.env)`);
  }
  return new Contract(addrs.manager, SUBSCRIPTION_MANAGER_ABI, runner);
}
