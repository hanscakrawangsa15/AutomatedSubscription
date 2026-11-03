// Creates the standard 5-tier plan set (matching frontend/src/lib/pricingTiers.ts)
// on a SubscriptionManager instance, via a single batched Safe multisig
// transaction. Reusable for every chain/token combination — not a one-off.
//
// Add DRY_RUN=1 to print everything and run all checks without signing/sending.
//
// Usage: SAFE_ADDRESS=0x... MANAGER_ADDRESS=0x... npx hardhat run scripts/create-plans-safe.js --network <name>
//
// Only supports 1-of-N Safes (a single owner's signature already meets
// threshold, so this script signs and executes in one run). A higher
// threshold needs the Safe UI or @safe-global/api-kit's proposal flow
// instead — out of scope here.
require("dotenv").config();
const hre = require("hardhat");
const Safe = require("@safe-global/protocol-kit").default;

const DAY = 24 * 60 * 60;

// Mirrors frontend/src/lib/pricingTiers.ts's PRICING_TIERS — keep in sync
// if tiers ever change there. Plans are immutable on-chain, so a re-price
// means running this script again (it appends 5 NEW plans) and then
// deactivating the old ones with scripts/deactivate-plans-safe.js —
// existing subscribers stay on their old plan, at their old price. Expressed in USD cents so centsToRaw can
// convert precisely for any token's decimals without floating-point error.
//
// Billing policy baked into every plan (SubscriptionManager v2):
//   leadDays  - the renewal charge window opens this many days BEFORE the paid
//               period ends; the keeper makes one attempt per day inside it
//               (day -2, -1, 0 => 3 attempts).
//   graceDays - 0: if the last attempt (at the period end) still fails, the
//               subscription is cancelled (Expired) right away.
// Same for monthly and yearly, e.g. bought 25 Sep 2026 -> attempts 23, 24, 25
// Oct 2026 (monthly) / 23, 24, 25 Sep 2027 (yearly).
const LEAD_DAYS = 2;
const GRACE_DAYS = 0;
const TIER_PLANS = [
  { label: "Starter (monthly)", cents: 1500, days: 30 },
  { label: "Basic (monthly)", cents: 3900, days: 30 },
  { label: "Basic (yearly)", cents: 37440, days: 365 },
  { label: "Advance (monthly)", cents: 7900, days: 30 },
  { label: "Advance (yearly)", cents: 75840, days: 365 },
];

function centsToRaw(cents, decimals) {
  if (decimals < 2) throw new Error(`Unsupported decimals=${decimals} (must be >= 2 for cents-based pricing)`);
  return (BigInt(cents) * 10n ** BigInt(decimals - 2)).toString();
}

// For a non-stablecoin payment token (e.g. WETH/WBNB) the $-priced tiers
// need converting through a reference token/USD price instead of the
// direct cents-to-raw assumption above (which only holds for tokens
// pegged 1:1 to USD). Fixed amount at deploy time, NOT a live oracle —
// this drifts from the tier's true USD value as the token's price moves,
// and needs a periodic manual re-price (new plans + deactivate old) if it
// drifts far enough to matter. Precise to 6 decimal places of the token
// (matches this project's existing cents-precision convention) regardless
// of the token's own decimals.
function usdCentsToTokenRaw(cents, decimals, referencePriceUsd) {
  const usd = cents / 100;
  const tokenAmount = usd / referencePriceUsd;
  // Avoid floating-point error at the wei level: work in micro-token units
  // (10^-6 of a whole token) via plain numbers, then scale up with BigInt.
  const microTokens = Math.round(tokenAmount * 1_000_000);
  if (decimals < 6) throw new Error(`Unsupported decimals=${decimals} (must be >= 6 for reference-price pricing)`);
  return (BigInt(microTokens) * 10n ** BigInt(decimals - 6)).toString();
}

async function main() {
  const safeAddress = process.env.SAFE_ADDRESS;
  const managerAddress = process.env.MANAGER_ADDRESS;
  if (!safeAddress || !managerAddress) {
    throw new Error("Set SAFE_ADDRESS and MANAGER_ADDRESS env vars before running this script.");
  }

  const rpcUrl = hre.network.config.url;
  const privateKey = hre.network.config.accounts[0];
  if (!rpcUrl || !privateKey) {
    throw new Error(`Network "${hre.network.name}" has no RPC URL / deployer key configured (check .env).`);
  }

  const managerCode = await hre.ethers.provider.getCode(managerAddress);
  if (managerCode === "0x") {
    throw new Error(`No contract found at ${managerAddress} on ${hre.network.name} — check MANAGER_ADDRESS.`);
  }

  // Plans on a v1 manager can't carry a leadTime, and a 4-argument createPlan
  // call against it would just revert after burning gas through the Safe. The
  // v2 selector is present in v2 bytecode only — refuse early instead.
  const manager = await hre.ethers.getContractAt("SubscriptionManager", managerAddress);
  const v2Selector = manager.interface.getFunction("createPlan").selector.slice(2);
  if (!managerCode.toLowerCase().includes(v2Selector)) {
    throw new Error(
      `${managerAddress} on ${hre.network.name} has no createPlan(price,interval,grace,leadTime) — it looks like a ` +
        `v1 manager. This script only creates plans on a v2 manager (deploy one first, see scripts/deploy.js).`,
    );
  }
  const tokenAddress = await manager.paymentToken();
  // Fetched live rather than passed as a param — a wrong manually-typed
  // decimals value would silently create plans priced off by orders of
  // magnitude, exactly the class of mistake this project avoids elsewhere
  // (see docs/mainnet-addresses.md's "never hardcode, always verify").
  const token = await hre.ethers.getContractAt(["function decimals() view returns (uint8)"], tokenAddress);
  const decimals = Number(await token.decimals());

  console.log(`Manager ${managerAddress} on ${hre.network.name} pays in token ${tokenAddress} (decimals=${decimals})`);

  const referencePriceUsd = process.env.REFERENCE_TOKEN_PRICE_USD ? Number(process.env.REFERENCE_TOKEN_PRICE_USD) : null;
  if (referencePriceUsd) {
    console.log(
      `Using REFERENCE_TOKEN_PRICE_USD=${referencePriceUsd} — this token is NOT a USD stablecoin, so tier ` +
        `amounts below are fixed at today's rate and will drift from their true $ value as the token's ` +
        `price moves. Re-run with an updated price (new plans + deactivate old) periodically.`,
    );
  }
  const toRaw = (cents) => (referencePriceUsd ? usdCentsToTokenRaw(cents, decimals, referencePriceUsd) : centsToRaw(cents, decimals));

  const existingCount = await manager.planCount();
  if (existingCount > 0n) {
    console.log(
      `Note: manager already has ${existingCount} plan(s) on-chain — this script always appends, never checks for duplicates.`,
    );
  }

  const transactions = TIER_PLANS.map((tier) => ({
    to: managerAddress,
    value: "0",
    data: manager.interface.encodeFunctionData("createPlan", [
      toRaw(tier.cents),
      tier.days * DAY,
      GRACE_DAYS * DAY,
      LEAD_DAYS * DAY,
    ]),
  }));

  console.log(`\nAbout to batch ${transactions.length} createPlan() calls through Safe ${safeAddress}:`);
  for (const tier of TIER_PLANS) {
    const amount = hre.ethers.formatUnits(toRaw(tier.cents), decimals);
    console.log(`  ${tier.label}: $${(tier.cents / 100).toFixed(2)} => ${amount} tokens / ${tier.days}d, charge window opens ${LEAD_DAYS}d early, ${GRACE_DAYS}d grace`);
  }

  const protocolKit = await Safe.init({ provider: rpcUrl, signer: privateKey, safeAddress });

  const [owners, threshold] = await Promise.all([protocolKit.getOwners(), protocolKit.getThreshold()]);
  console.log(`\nSafe ${safeAddress}: ${owners.length} owner(s), threshold ${threshold}.`);
  if (threshold > 1) {
    throw new Error(
      `Safe threshold is ${threshold} (>1) — this script only supports 1-of-N Safes where a single ` +
        `signature already meets the threshold and can execute immediately. Propose this transaction ` +
        `via the Safe UI or @safe-global/api-kit instead for a higher-threshold Safe.`,
    );
  }

  if (process.env.DRY_RUN === "1") {
    console.log("\nDRY_RUN=1 — nothing signed or sent. Re-run without DRY_RUN to execute.");
    return;
  }

  const safeTx = await protocolKit.createTransaction({ transactions });
  const signedTx = await protocolKit.signTransaction(safeTx);

  console.log("Executing...");
  const execResult = await protocolKit.executeTransaction(signedTx);
  const receipt = await execResult.transactionResponse?.wait?.();
  console.log(`Executed in tx ${receipt?.hash ?? execResult.hash}`);

  console.log("\n--- On-chain read-back ---");
  const finalCount = await manager.planCount();
  for (let i = 0; i < Number(finalCount); i++) {
    const p = await manager.plans(i);
    console.log(
      `  Plan #${i}: ${hre.ethers.formatUnits(p.price, decimals)} tokens / ${Number(p.interval) / DAY}d, ` +
        `${Number(p.gracePeriod) / DAY}d grace, lead ${Number(p.leadTime) / DAY}d, active=${p.active}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
