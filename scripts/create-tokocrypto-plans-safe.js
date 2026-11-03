// Creates the Tokocrypto partner-discount plans on a v2 SubscriptionManager
// via ONE batched Safe transaction: 5 createPlan() calls followed by 5
// setPromo() calls that link each discounted plan to its normal-price
// successor already on the same manager.
//
// How the discount behaves (enforced by the contract, see setPromo):
//   monthly  - the first 12 payments (purchase + 11 renewals) are discounted,
//              payment 13 onward is charged at the normal monthly price;
//   yearly   - only the first purchase is discounted, the next year is charged
//              at the normal yearly price.
// The switch is automatic: same keeper, same schedule, no user action.
//
// The normal plans (Starter/Basic/Advance at $15/$39/$374.40/$79/$758.40) must
// already exist on this manager (scripts/create-plans-safe.js). Each successor
// is found on-chain by price + interval; the script refuses to guess if a
// match is missing or ambiguous, and refuses to create plans that already exist.
//
// The same contract serves any future campaign: copy this file's PLANS table
// with the new prices (or later turn a campaign off with
// setPlanActive(planId,false) — existing subscribers are unaffected).
//
// Add DRY_RUN=1 to print everything and run all checks without signing/sending.
//
// Usage: SAFE_ADDRESS=0x... MANAGER_ADDRESS=0x... npx hardhat run scripts/create-tokocrypto-plans-safe.js --network <name>
//
// Only supports 1-of-N Safes (same limitation as create-plans-safe.js).
require("dotenv").config();
const hre = require("hardhat");
const Safe = require("@safe-global/protocol-kit").default;

const DAY = 24 * 60 * 60;
// Must equal the normal plans' billing policy (setPromo enforces equality).
const LEAD_DAYS = 2;
const GRACE_DAYS = 0;

// Fixed prices from the partnership (USD cents). normalCents = the price of
// the successor plan the subscriber moves to after `periods` payments.
const PLANS = [
  { label: "Starter (monthly) · Tokocrypto", cents: 1350, normalCents: 1500, days: 30, periods: 12 },
  { label: "Basic (monthly) · Tokocrypto", cents: 3510, normalCents: 3900, days: 30, periods: 12 },
  { label: "Basic (yearly) · Tokocrypto", cents: 32760, normalCents: 37440, days: 365, periods: 1 },
  { label: "Advance (monthly) · Tokocrypto", cents: 7110, normalCents: 7900, days: 30, periods: 12 },
  { label: "Advance (yearly) · Tokocrypto", cents: 66360, normalCents: 75840, days: 365, periods: 1 },
];

function centsToRaw(cents, decimals) {
  if (decimals < 2) throw new Error(`Unsupported decimals=${decimals} (must be >= 2 for cents-based pricing)`);
  return BigInt(cents) * 10n ** BigInt(decimals - 2);
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
  const promoSelector = manager.interface.getFunction("setPromo").selector.slice(2);
  if (!managerCode.toLowerCase().includes(promoSelector)) {
    throw new Error(
      `${managerAddress} on ${hre.network.name} has no setPromo() — it's a v1 / pre-promo manager. ` +
        `Deploy the current contract first (scripts/deploy.js).`,
    );
  }

  const tokenAddress = await manager.paymentToken();
  const token = await hre.ethers.getContractAt(["function decimals() view returns (uint8)"], tokenAddress);
  const decimals = Number(await token.decimals());
  console.log(`Manager ${managerAddress} on ${hre.network.name} pays in token ${tokenAddress} (decimals=${decimals})`);

  // Read every existing plan once, to resolve successors and detect duplicates.
  const count = Number(await manager.planCount());
  const existing = [];
  for (let i = 0; i < count; i++) {
    const p = await manager.plans(i);
    const promo = await manager.promos(i);
    existing.push({
      id: i,
      price: p.price,
      interval: Number(p.interval),
      grace: Number(p.gracePeriod),
      lead: Number(p.leadTime),
      active: p.active,
      isPromo: promo.periods > 0n,
    });
  }
  console.log(`Manager has ${count} existing plan(s).`);

  const rows = PLANS.map((plan, index) => {
    const priceRaw = centsToRaw(plan.cents, decimals);
    const normalRaw = centsToRaw(plan.normalCents, decimals);
    const interval = plan.days * DAY;
    const same = (p, price) => p.price === price && p.interval === interval;

    const dupes = existing.filter((p) => same(p, priceRaw));
    if (dupes.length > 0) {
      throw new Error(
        `${plan.label}: a plan with this price + interval already exists (#${dupes.map((p) => p.id).join(", #")}) — ` +
          `refusing to create a duplicate. Remove it from PLANS if it was created already.`,
      );
    }
    const successors = existing.filter(
      (p) => same(p, normalRaw) && p.active && !p.isPromo && p.lead === LEAD_DAYS * DAY && p.grace === GRACE_DAYS * DAY,
    );
    if (successors.length !== 1) {
      throw new Error(
        `${plan.label}: expected exactly one active normal plan at $${(plan.normalCents / 100).toFixed(2)} / ${plan.days}d ` +
          `with lead ${LEAD_DAYS}d + grace ${GRACE_DAYS}d, found ${successors.length}. Create the normal plans first ` +
          `(create-plans-safe.js) or deactivate the extra copy.`,
      );
    }
    return { ...plan, priceRaw, interval, successorId: successors[0].id, newId: count + index };
  });

  const transactions = [
    ...rows.map((r) => ({
      to: managerAddress,
      value: "0",
      data: manager.interface.encodeFunctionData("createPlan", [
        r.priceRaw,
        r.interval,
        GRACE_DAYS * DAY,
        LEAD_DAYS * DAY,
      ]),
    })),
    ...rows.map((r) => ({
      to: managerAddress,
      value: "0",
      data: manager.interface.encodeFunctionData("setPromo", [r.newId, r.successorId, r.periods]),
    })),
  ];

  console.log(`\nAbout to batch ${transactions.length} calls (${rows.length} createPlan + ${rows.length} setPromo) through Safe ${safeAddress}:`);
  for (const r of rows) {
    console.log(
      `  #${r.newId} ${r.label}: $${(r.cents / 100).toFixed(2)} for ${r.periods} payment(s), ` +
        `then plan #${r.successorId} at $${(r.normalCents / 100).toFixed(2)}`,
    );
  }

  const protocolKit = await Safe.init({ provider: rpcUrl, signer: privateKey, safeAddress });
  const [owners, threshold] = await Promise.all([protocolKit.getOwners(), protocolKit.getThreshold()]);
  console.log(`\nSafe ${safeAddress}: ${owners.length} owner(s), threshold ${threshold}.`);
  if (threshold > 1) {
    throw new Error(
      `Safe threshold is ${threshold} (>1) — this script only supports 1-of-N Safes. Propose this batch via the ` +
        `Safe UI or @safe-global/api-kit instead.`,
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
  for (const r of rows) {
    const p = await manager.plans(r.newId);
    const promo = await manager.promos(r.newId);
    console.log(
      `  Plan #${r.newId}: ${hre.ethers.formatUnits(p.price, decimals)} tokens / ${Number(p.interval) / DAY}d, ` +
        `lead ${Number(p.leadTime) / DAY}d, active=${p.active}, promo ${promo.periods} payment(s) -> #${promo.successorId}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
