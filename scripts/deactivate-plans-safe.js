// Deactivates plans on a SubscriptionManager instance via a single batched
// Safe multisig transaction — the second half of a re-price (see
// create-plans-safe.js): new plans are created first, then the retired ones
// are switched off here.
//
// setPlanActive(planId, false) only blocks NEW subscribe() calls on that
// plan. Existing subscribers keep renewing at the old price — chargeDue,
// retryCharge and payNow never check Plan.active (see the contract's
// Plan.active doc comment) — so nobody is migrated or re-priced.
//
// Add DRY_RUN=1 to print everything and run all checks without signing/sending.
//
// Usage: SAFE_ADDRESS=0x... MANAGER_ADDRESS=0x... PLAN_IDS=0,1,2,3,4 npx hardhat run scripts/deactivate-plans-safe.js --network <name>
//
// Only supports 1-of-N Safes, same limitation as create-plans-safe.js.
require("dotenv").config();
const hre = require("hardhat");
const Safe = require("@safe-global/protocol-kit").default;

async function main() {
  const safeAddress = process.env.SAFE_ADDRESS;
  const managerAddress = process.env.MANAGER_ADDRESS;
  const planIds = (process.env.PLAN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (!safeAddress || !managerAddress || planIds.length === 0) {
    throw new Error("Set SAFE_ADDRESS, MANAGER_ADDRESS and PLAN_IDS (comma-separated, e.g. 0,1,2,3,4).");
  }
  if (planIds.some((id) => !Number.isInteger(id) || id < 0)) {
    throw new Error(`PLAN_IDS must be non-negative integers, got "${process.env.PLAN_IDS}".`);
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
  const token = await hre.ethers.getContractAt(["function decimals() view returns (uint8)"], tokenAddress);
  const decimals = Number(await token.decimals());
  const planCount = Number(await manager.planCount());

  console.log(`Manager ${managerAddress} on ${hre.network.name} (${planCount} plans, token decimals=${decimals})\n`);
  console.log("Current plans:");
  for (let i = 0; i < planCount; i++) {
    const p = await manager.plans(i);
    const marker = planIds.includes(i) ? "  <-- will be deactivated" : "";
    console.log(`  Plan #${i}: ${hre.ethers.formatUnits(p.price, decimals)} / ${Number(p.interval) / 86400}d, active=${p.active}${marker}`);
  }

  for (const id of planIds) {
    if (id >= planCount) throw new Error(`Plan #${id} doesn't exist (planCount=${planCount}).`);
  }

  // Guard against the easy mistake of retiring the old plans before the new
  // ones exist — that would leave the pricing page with nothing to sell.
  const remainingActive = [];
  for (let i = 0; i < planCount; i++) {
    if (planIds.includes(i)) continue;
    if ((await manager.plans(i)).active) remainingActive.push(i);
  }
  if (remainingActive.length === 0) {
    throw new Error("This would leave no active plan at all — create the new plans first (create-plans-safe.js).");
  }

  const transactions = planIds.map((id) => ({
    to: managerAddress,
    value: "0",
    data: manager.interface.encodeFunctionData("setPlanActive", [id, false]),
  }));

  const protocolKit = await Safe.init({ provider: rpcUrl, signer: privateKey, safeAddress });
  const [owners, threshold] = await Promise.all([protocolKit.getOwners(), protocolKit.getThreshold()]);
  console.log(`\nSafe ${safeAddress}: ${owners.length} owner(s), threshold ${threshold}.`);
  if (threshold > 1) {
    throw new Error(
      `Safe threshold is ${threshold} (>1) — this script only supports 1-of-N Safes. Propose ` +
        `setPlanActive(planId, false) for each plan via the Safe UI instead.`,
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
  for (let i = 0; i < planCount; i++) {
    const p = await manager.plans(i);
    console.log(`  Plan #${i}: ${hre.ethers.formatUnits(p.price, decimals)} / ${Number(p.interval) / 86400}d, active=${p.active}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
