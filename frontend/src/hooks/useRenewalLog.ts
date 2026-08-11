import { useEffect, useState } from "react";
import { formatUnits, type EventLog } from "ethers";
import { getMockUsdc, getSubscriptionManager } from "../lib/contracts";
import { getReadProvider } from "../lib/readProvider";

export type RenewalEntry = {
  key: string;
  amount: string;
  timestamp: number;
};

const MAX_ENTRIES = 8;

// Public RPC providers cap how many blocks a single eth_getLogs call can
// span (commonly 10k-50k) — querying "from block 0" works on a young local
// chain but hard-fails on a real testnet with millions of blocks. Query a
// bounded recent window instead, shrinking it if the provider's own cap is
// even stricter than our default guess.
const DEFAULT_LOOKBACK_BLOCKS = 10_000;

async function queryRecentCharges(
  provider: ReturnType<typeof getReadProvider>,
  manager: ReturnType<typeof getSubscriptionManager>,
  account: string,
) {
  if (!provider) return [];
  const filter = manager.filters.Charged(account);
  const latest = await provider.getBlockNumber();
  let lookback = DEFAULT_LOOKBACK_BLOCKS;

  while (lookback >= 500) {
    const fromBlock = Math.max(0, latest - lookback);
    try {
      const logs = await manager.queryFilter(filter, fromBlock);
      return logs.filter((log): log is EventLog => "args" in log);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/block range|exceed/i.test(message)) throw err;
      lookback = Math.floor(lookback / 4);
    }
  }
  return [];
}

/**
 * Watches the SubscriptionManager's Charged event for one account so the UI
 * can show renewals as they happen, instead of only reflecting state after
 * the user manually triggers a refresh.
 *
 * Deliberately reads through our own dedicated RPC (getReadProvider) rather
 * than the connected wallet's provider: MetaMask's own configured RPC for a
 * custom network can reject eth_getLogs outright when it's bundled in a
 * batch with other simultaneous calls (observed on BSC Testnet's default
 * RPC) — a hard rejection, not something retries can work around, since the
 * same batching happens on every retry. A dedicated read-only connection we
 * control sidesteps that regardless of what the wallet is configured with.
 */
export function useRenewalLog(account: string, chainId: number | bigint) {
  const [entries, setEntries] = useState<RenewalEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const readProvider = getReadProvider(chainId);
    if (!readProvider) return;

    const manager = getSubscriptionManager(readProvider, chainId);
    const usdc = getMockUsdc(readProvider, chainId);
    const filter = manager.filters.Charged(account);

    const backfill = async () => {
      const decimals = await usdc.decimals();
      const logs = await queryRecentCharges(readProvider, manager, account);
      const recent = logs.slice(-MAX_ENTRIES).reverse();
      const loaded = await Promise.all(
        recent.map(async (log) => {
          const block = await log.getBlock();
          return {
            key: `${log.transactionHash}-${log.index}`,
            amount: formatUnits(log.args.amount as bigint, decimals),
            timestamp: block.timestamp,
          };
        }),
      );
      if (!cancelled) setEntries(loaded);
    };

    // ethers v6 doesn't reliably pass positional decoded args when the
    // listener was attached via a prepared filter (contract.filters.X(...))
    // rather than a plain event-name string — it can call the listener with
    // just the payload as a single argument. Read everything off the
    // payload (always the last argument) instead of trusting positions.
    const handleCharged = async (...callbackArgs: unknown[]) => {
      const payload = callbackArgs[callbackArgs.length - 1] as
        | { args: { amount: bigint }; log: EventLog; getBlock: () => Promise<{ timestamp: number }> }
        | undefined;
      if (!payload?.log) return;

      const decimals = await usdc.decimals();
      const block = await payload.getBlock();
      const entry: RenewalEntry = {
        key: `${payload.log.transactionHash}-${payload.log.index}`,
        amount: formatUnits(payload.args.amount, decimals),
        timestamp: block.timestamp,
      };
      if (cancelled) return;
      setEntries((prev) => [entry, ...prev.filter((e) => e.key !== entry.key)].slice(0, MAX_ENTRIES));
    };

    backfill().catch((err) => console.error("Renewal log backfill failed:", err));
    manager.on(filter, handleCharged);

    return () => {
      cancelled = true;
      manager.off(filter, handleCharged);
    };
  }, [account, chainId]);

  return entries;
}
