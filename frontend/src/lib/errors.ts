import { IS_TRON_MAINNET_MODE } from "./tronContracts";

export function formatTxError(err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code === "ACTION_REJECTED") {
    return "You rejected the request in your wallet. Nothing happened — click Confirm & Subscribe to try again.";
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes("insufficient funds")) {
    return "This wallet doesn't have enough ETH to pay gas. Fund it with test ETH and try again.";
  }
  if (lower.includes("insufficient allowance")) {
    return "USDC allowance is too low. Approve again and retry.";
  }
  if (lower.includes("transfer amount exceeds balance") || lower.includes("insufficient balance")) {
    return "Not enough USDC in this wallet to cover the price.";
  }
  if (lower.includes("bad_data") || lower.includes("could not decode result data")) {
    return "Couldn't reach the contract on this network. Make sure your wallet is on the correct chain.";
  }
  if (lower.includes("smart contract is not exist")) {
    return `Couldn't find the contract on this network. Make sure TronLink is set to ${IS_TRON_MAINNET_MODE ? "Mainnet" : "Nile testnet"}, then try again.`;
  }
  if (lower.includes("confirmation declined") || lower.includes("user rejected") || lower.includes("user denied")) {
    return "You rejected the request in your wallet. Nothing happened — click Confirm & Subscribe to try again.";
  }
  if (lower.includes("owner_address isn't set") || lower.includes("owner_address is not set")) {
    return "TronLink isn't fully ready yet. Wait a moment and try again.";
  }

  return message;
}
