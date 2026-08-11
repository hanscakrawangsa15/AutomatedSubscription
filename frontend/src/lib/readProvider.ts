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

  const provider = new JsonRpcProvider(rpcUrl);
  providerCache.set(id, provider);
  return provider;
}
