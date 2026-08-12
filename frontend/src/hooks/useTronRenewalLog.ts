import { useEffect, useState } from "react";
import { TronWeb } from "tronweb";
import { getTronAddresses, getTronUsdcRead } from "../lib/tronContracts";

export type RenewalEntry = {
  key: string;
  amount: string;
  timestamp: number;
};

const MAX_ENTRIES = 8;
const POLL_INTERVAL_MS = 15_000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h window, refreshed each poll
const FULL_HOST = import.meta.env.VITE_TRON_FULL_HOST || "https://nile.trongrid.io";

/**
 * TRON equivalent of useRenewalLog.ts. TronGrid's event API is a polled
 * REST endpoint (no push/subscribe support here), and it doesn't support
 * filtering by an indexed param's value server-side the way eth_getLogs
 * topics do — so this fetches recent Charged events for the contract and
 * filters by `result.user` client-side, same approach as the discovery
 * scan in scripts/keeper.tron.js.
 */
export function useTronRenewalLog(account: string | null) {
  const [entries, setEntries] = useState<RenewalEntry[]>([]);

  useEffect(() => {
    if (!account) {
      setEntries([]);
      return;
    }
    const addrs = getTronAddresses();
    if (!addrs) return;

    let cancelled = false;
    const tronWeb = new TronWeb({ fullHost: FULL_HOST });

    const poll = async () => {
      const usdc = getTronUsdcRead();
      if (!usdc) return;
      const decimals = await usdc.decimals().call();

      const res = await tronWeb.getEventResult(addrs.manager, {
        eventName: "Charged",
        minBlockTimestamp: Date.now() - LOOKBACK_MS,
        orderBy: "block_timestamp,desc",
        limit: 200,
      });
      if (cancelled) return;

      const mine = (res.data || []).filter((ev) => {
        const user = ev.result.user;
        return user === account || tronWeb.address.fromHex(user) === account;
      });

      const loaded: RenewalEntry[] = mine.slice(0, MAX_ENTRIES).map((ev) => ({
        key: `${ev.transaction_id}-${ev.event_index}`,
        amount: (Number(ev.result.amount) / 10 ** Number(decimals)).toString(),
        timestamp: Math.floor(ev.block_timestamp / 1000),
      }));
      setEntries(loaded);
    };

    poll().catch((err) => console.error("Tron renewal log poll failed:", err));
    const interval = setInterval(() => {
      poll().catch((err) => console.error("Tron renewal log poll failed:", err));
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [account]);

  return entries;
}
