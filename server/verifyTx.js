// On-chain verification for POST /api/subscribers.
//
// The endpoint is public (the subscriber's browser calls it right after a
// transaction confirms), so nothing in its body can be trusted. Instead the
// caller supplies only a txHash + chainId + address, and this module proves
// from the chain itself that the transaction really was a SubscriptionManager
// action by that address, then reads the resulting subscription state
// straight from the contract. The request body is never the source of truth
// for status / plan / periods / schedule.
const { JsonRpcProvider, Interface, getAddress } = require("ethers");

// RPC env var per chain — same names hardhat.config.js already uses, so no
// new configuration is needed for an existing deployment.
const RPC_ENV = {
  1: "MAINNET_RPC_URL",
  56: "BSC_RPC_URL",
  8453: "BASE_RPC_URL",
  11155111: "SEPOLIA_RPC_URL",
  84532: "BASE_SEPOLIA_RPC_URL",
  97: "BSC_TESTNET_RPC_URL",
};

const MANAGER_ENV_RE = /^SUBSCRIPTION_MANAGER_ADDRESS_(\d+)(?:_[A-Z0-9]+)*$/;

const iface = new Interface([
  "event Subscribed(address indexed user, uint256 indexed planId, uint256 nextChargeAt)",
  "event Charged(address indexed user, uint256 indexed planId, uint256 amount, uint256 nextChargeAt)",
  "event Reactivated(address indexed user, uint256 nextChargeAt)",
  "event Cancelled(address indexed user)",
  "function subscriptions(address) view returns (uint256 planId, uint8 status, uint256 nextChargeAt, uint256 overdueSince, uint256 periodsPaid)",
]);

const STATUS_LABELS = ["inactive", "active", "overdue", "expired"];

class VerificationError extends Error {
  constructor(message, httpStatus = 422) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

const providers = new Map();

function providerFor(chainId) {
  const envName = RPC_ENV[chainId];
  const url = envName && process.env[envName];
  if (!url) return null;
  if (!providers.has(chainId)) providers.set(chainId, new JsonRpcProvider(url, chainId, { staticNetwork: true }));
  return providers.get(chainId);
}

/** Every SubscriptionManager configured for this chain (one per payment token). */
function managersFor(chainId) {
  const out = new Set();
  for (const [key, value] of Object.entries(process.env)) {
    const m = MANAGER_ENV_RE.exec(key);
    if (m && Number(m[1]) === chainId && value) out.add(value.toLowerCase());
  }
  return out;
}

async function getReceiptWithRetry(provider, txHash) {
  // The browser's own RPC node may be a block ahead of ours — one retry is
  // enough to cover that, and each attempt is a paid RPC call.
  for (let attempt = 0; attempt < 2; attempt++) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/**
 * @returns {Promise<{
 *   chainId: number, planId: number, status: string, periodsPaid: number,
 *   nextChargeAt: number, activatedAt: number | null, blockTimestamp: number,
 *   subscribed: boolean, charged: boolean
 * }>}
 * @throws {VerificationError} when the transaction doesn't prove what the
 *   caller claims.
 */
async function verifySubscriptionTx({ chainId, txHash, address }) {
  const provider = providerFor(chainId);
  const managers = managersFor(chainId);
  if (!provider || managers.size === 0) {
    throw new VerificationError(`chain ${chainId} isn't configured for verification on this server`, 400);
  }

  let receipt;
  try {
    receipt = await getReceiptWithRetry(provider, txHash);
  } catch (err) {
    throw new VerificationError(`RPC error while verifying transaction: ${err.message}`, 502);
  }
  if (!receipt) throw new VerificationError("transaction not found", 404);
  if (receipt.status !== 1) throw new VerificationError("transaction reverted");

  const user = getAddress(address);
  let managerAddress = null;
  let subscribed = false;
  let charged = false;
  let touched = false;
  for (const log of receipt.logs) {
    if (!managers.has(log.address.toLowerCase())) continue;
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }
    if (!parsed || parsed.args.user !== user) continue;
    managerAddress = log.address;
    touched = true;
    if (parsed.name === "Subscribed") subscribed = true;
    if (parsed.name === "Charged") charged = true;
  }
  if (!touched) throw new VerificationError("transaction has no SubscriptionManager event for this address");

  let sub;
  let block;
  try {
    const data = iface.encodeFunctionData("subscriptions", [user]);
    const raw = await provider.call({ to: managerAddress, data });
    sub = iface.decodeFunctionResult("subscriptions", raw);
    block = await provider.getBlock(receipt.blockNumber);
  } catch (err) {
    throw new VerificationError(`RPC error while reading subscription: ${err.message}`, 502);
  }

  const blockTimestamp = Number(block.timestamp);
  return {
    chainId,
    planId: Number(sub.planId),
    status: STATUS_LABELS[Number(sub.status)] ?? null,
    periodsPaid: Number(sub.periodsPaid),
    nextChargeAt: Number(sub.nextChargeAt),
    // Only a tx that actually moved funds counts as an "activation".
    activatedAt: charged ? blockTimestamp : null,
    blockTimestamp,
    subscribed,
    charged,
  };
}

module.exports = { verifySubscriptionTx, VerificationError };
