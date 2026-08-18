// Creates ONE internal QA plan on a SubscriptionManager instance, via a
// Safe multisig transaction — $1, charges hourly, exists purely to verify
// the keeper's auto-charge flow end-to-end on real mainnet without waiting
// a full 30-day billing cycle. classifyInterval() (frontend/src/lib/plans.ts)
// buckets any interval < 1 day as kind "test" automatically, so no schema
// change was needed — it's surfaced in the UI as its own small card
// (PricingTiers.tsx), separate from the customer-facing tier set.
//
// Usage: SAFE_ADDRESS=0x... MANAGER_ADDRESS=0x... npx hardhat run scripts/create-test-plan-safe.js --network <name>
//
// Only supports 1-of-N Safes (a single owner's signature already meets
// threshold, so this script signs and executes in one run) — same
// limitation as create-plans-safe.js.
require("dotenv").config();
const hre = require("hardhat");
const Safe = require("@safe-global/protocol-kit").default;

const PRICE_CENTS = 100; // $1.00
const INTERVAL_SECONDS = 60 * 60; // 1 hour
const GRACE_SECONDS = 30 * 60; // 30 minutes

function centsToRaw(cents, decimals) {
  if (decimals < 2) throw new Error(`Unsupported decimals=${decimals} (must be >= 2 for cents-based pricing)`);
  return (BigInt(cents) * 10n ** BigInt(decimals - 2)).toString();
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

  const manager = await hre.ethers.getContractAt("SubscriptionManager", managerAddress);
  const tokenAddress = await manager.paymentToken();
  const token = await hre.ethers.getContractAt(
    ["function decimals() view returns (uint8)", "function symbol() view returns (string)"],
    tokenAddress,
  );
  const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
  const priceRaw = centsToRaw(PRICE_CENTS, Number(decimals));

  console.log(`Manager ${managerAddress} on ${hre.network.name} pays in ${symbol} (decimals=${decimals})`);
  console.log(
    `Creating test plan: ${hre.ethers.formatUnits(priceRaw, decimals)} ${symbol} / ${INTERVAL_SECONDS}s ` +
      `(1h), ${GRACE_SECONDS}s grace (30m)`,
  );

  const data = manager.interface.encodeFunctionData("createPlan", [priceRaw, INTERVAL_SECONDS, GRACE_SECONDS]);

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

  const safeTx = await protocolKit.createTransaction({
    transactions: [{ to: managerAddress, value: "0", data }],
  });
  const signedTx = await protocolKit.signTransaction(safeTx);

  console.log("Executing...");
  const execResult = await protocolKit.executeTransaction(signedTx);
  const receipt = await execResult.transactionResponse?.wait?.();
  console.log(`Executed in tx ${receipt?.hash ?? execResult.hash}`);

  const finalCount = await manager.planCount();
  const newPlanId = finalCount - 1n;
  const newPlan = await manager.plans(newPlanId);
  console.log(
    `\nNew plan #${newPlanId}: ${hre.ethers.formatUnits(newPlan.price, decimals)} ${symbol} / ` +
      `${Number(newPlan.interval)}s, ${Number(newPlan.gracePeriod)}s grace, active=${newPlan.active}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
