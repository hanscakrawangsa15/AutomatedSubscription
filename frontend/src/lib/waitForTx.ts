import type { TransactionReceipt, TransactionResponse } from "ethers";
import { getReadProvider } from "./readProvider";

/**
 * Waits for a submitted transaction to confirm, falling back to our own
 * dedicated RPC (see readProvider.ts) if the wallet's own configured RPC
 * fails mid-poll — observed in production: a mobile wallet's default BSC
 * RPC returning HTTP 403 on eth_getTransactionReceipt for a transaction
 * that had, in fact, already succeeded on-chain. tx.wait() has no way to
 * tell "the RPC hiccuped" apart from "this genuinely isn't confirming", so
 * without this fallback a flaky wallet RPC surfaces as a scary raw error
 * for an action that actually went through — misleading the user into
 * thinking it failed (and potentially retrying/paying for it again).
 */
export async function waitForTx(tx: TransactionResponse, chainId: number | bigint): Promise<TransactionReceipt | null> {
  try {
    return await tx.wait();
  } catch (err) {
    const readProvider = getReadProvider(chainId);
    if (!readProvider) throw err;
    const receipt = await readProvider.waitForTransaction(tx.hash, 1, 120_000).catch(() => null);
    if (!receipt) throw err;
    return receipt;
  }
}
