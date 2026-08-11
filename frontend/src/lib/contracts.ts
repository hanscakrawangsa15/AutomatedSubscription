import { Contract, type Signer, type Provider } from "ethers";
import { MOCK_USDC_ABI } from "../abi/MockUSDC";
import { SUBSCRIPTION_MANAGER_ABI } from "../abi/SubscriptionManager";

type ChainAddresses = { usdc: string; manager: string };

function readAddresses(chainId: number): ChainAddresses | null {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const usdc = env[`VITE_USDC_ADDRESS_${chainId}`];
  const manager = env[`VITE_SUBSCRIPTION_MANAGER_ADDRESS_${chainId}`];
  if (!usdc || !manager) return null;
  return { usdc, manager };
}

const addressCache = new Map<number, ChainAddresses | null>();

export function getChainAddresses(chainId: number | bigint | null | undefined): ChainAddresses | null {
  if (chainId === null || chainId === undefined) return null;
  const id = Number(chainId);
  if (!addressCache.has(id)) addressCache.set(id, readAddresses(id));
  return addressCache.get(id) ?? null;
}

export function isChainDeployed(chainId: number | bigint | null | undefined): boolean {
  return getChainAddresses(chainId) !== null;
}

export function getMockUsdc(runner: Signer | Provider, chainId: number | bigint) {
  const addrs = getChainAddresses(chainId);
  if (!addrs) throw new Error(`MockUSDC isn't configured for chain ${chainId} (check frontend/.env)`);
  return new Contract(addrs.usdc, MOCK_USDC_ABI, runner);
}

export function getSubscriptionManager(runner: Signer | Provider, chainId: number | bigint) {
  const addrs = getChainAddresses(chainId);
  if (!addrs) {
    throw new Error(`SubscriptionManager isn't configured for chain ${chainId} (check frontend/.env)`);
  }
  return new Contract(addrs.manager, SUBSCRIPTION_MANAGER_ABI, runner);
}
