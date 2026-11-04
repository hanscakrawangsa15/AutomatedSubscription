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
  // v2 only — reverts on a v1 manager (handled below).
  "function promos(uint256) view returns (uint256 periods, uint256 successorId)",
]);

// Name stored in subscribers.campaign for a plan that has a promo attached
// on-chain (Promo.periods > 0). Today the only partner promo is Tokocrypto;
// a second campaign needs its own mapping here (e.g. by plan id).
const PROMO_CAMPAIGN = "tokocrypto";

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
 *   chainId: number, managerAddress: string, campaign: string | null, planId: number, status: string, periodsPaid: number,
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
  let subscribedPlanId = null;
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
    if (parsed.name === "Subscribed") {
      subscribed = true;
      subscribedPlanId = parsed.args.planId;
    }
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

  // Campaign is only (re)decided by a tx that actually bought a plan: "" when
  // it was a normal plan (clears an old campaign on a re-subscribe), null for
  // renewals/other txs (leave the stored value alone). A v1 manager has no
  // promos() — that call reverts, which simply means "not a promo".
  let campaign = null;
  if (subscribed) {
    campaign = "";
    try {
      const raw = await provider.call({ to: managerAddress, data: iface.encodeFunctionData("promos", [subscribedPlanId]) });
      const promo = iface.decodeFunctionResult("promos", raw);
      if (promo.periods > 0n) campaign = PROMO_CAMPAIGN;
    } catch (err) {
      // A v1 manager reverts (CALL_EXCEPTION/BAD_DATA) = definitely not a promo.
      // Anything else (RPC hiccup) = unknown: keep the stored value.
      if (err?.code !== "CALL_EXCEPTION" && err?.code !== "BAD_DATA") campaign = null;
    }
  }

  const blockTimestamp = Number(block.timestamp);
  return {
    chainId,
    managerAddress: managerAddress.toLowerCase(),
    campaign,
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
