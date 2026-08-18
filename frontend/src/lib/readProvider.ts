import { JsonRpcProvider, type Provider } from "ethers";
import { SUPPORTED_CHAINS } from "./chains";

const providerCache = new Map<number, Provider>();

/**
 * Read-only provider for a given chain, used to show plan pricing before a
 * wallet connects (or for whichever chain is currently selected). Each
 * supported chain carries its own default RPC URL, so this works without
 * needing an injected wallet at all.
 */
export function getReadProvider(chainId: number | bigint): Provider | null {
  const id = Number(chainId);
  const cached = providerCache.get(id);
  if (cached) return cached;

  const chain = SUPPORTED_CHAINS.find((c) => Number(c.id) === id);
  const rpcUrl = chain?.rpcUrls?.default?.http?.[0];
  if (!rpcUrl) return null;

  // Batching (off by default in ethers v6 — batchMaxCount defaults to 1)
  // combines calls made within the same ~20ms window into a single HTTP
  // POST carrying a JSON-RPC batch array. fetchPlans alone fires 3+N
  // requests (planCount/decimals/symbol + one per plan); with 2-3 payment
  // methods loading near-simultaneously that's a real burst of separate
  // HTTP requests — exactly what trips a free-tier RPC's requests-per-
  // second cap, independent of how few actual compute units the reads
  // themselves cost.
  const provider = new JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 25, batchStallTime: 20 });
  providerCache.set(id, provider);
  return provider;
}
