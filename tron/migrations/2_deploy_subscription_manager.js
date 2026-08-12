const { TronWeb } = require("tronweb");
const Migrations = artifacts.require("Migrations");
const MockUSDC = artifacts.require("MockUSDC");
const SubscriptionManager = artifacts.require("SubscriptionManager");

// TronBox contract instances' `.address` is raw hex ("41...") — the
// frontend/keeper (and the rest of the Tron ecosystem) expect base58
// ("T..."). TronWeb.address.fromHex() is a pure static conversion, no
// connection needed.
function base58(hexAddress) {
  return TronWeb.address.fromHex(hexAddress);
}

const MINUTE = 60;
const DAY = 24 * 60 * 60;
const USDC_DECIMALS = 1_000_000n; // MockUSDC is fixed at 6 decimals

function usdc(amount) {
  return (BigInt(amount) * USDC_DECIMALS).toString();
}

// Mirrors scripts/deploy.js's testnet path: deploy MockUSDC, deploy
// SubscriptionManager(usdc, deployer) with treasury = deployer (same
// convention as every other testnet deployment), create the same three
// plans, mint test tokens to the deployer.
module.exports = async function (deployer) {
  // `accounts` (the migration function's 3rd param) comes back empty under
  // this TronBox version — read the deployer address off the just-deployed
  // Migrations contract's owner() instead (set to msg.sender in its
  // constructor), which is reliably populated.
  const migrations = await Migrations.deployed();
  const deployerAddress = await migrations.owner();

  await deployer.deploy(MockUSDC);
  const usdcInstance = await MockUSDC.deployed();
  console.log(`MockUSDC deployed to ${usdcInstance.address}`);

  await deployer.deploy(SubscriptionManager, usdcInstance.address, deployerAddress);
  const manager = await SubscriptionManager.deployed();
  console.log(`SubscriptionManager deployed to ${manager.address}`);

  await manager.createPlan(usdc(10), 30 * DAY, 5 * DAY);
  console.log("Created Monthly plan: 10 USDC / 30 days, 5 day grace period");

  await manager.createPlan(usdc(100), 365 * DAY, 10 * DAY);
  console.log("Created Yearly plan: 100 USDC / 365 days, 10 day grace period");

  await manager.createPlan(usdc(1), 3 * MINUTE, 2 * MINUTE);
  console.log("Created Test plan: 1 USDC / 3 minutes, 2 minute grace period (for fast renewal testing)");

  await usdcInstance.mint(deployerAddress, usdc(100000));
  console.log(`Minted 100,000 test USDC to deployer ${base58(deployerAddress)}`);

  console.log(`\n--- Add these to frontend/.env ---`);
  console.log(`VITE_TRON_NILE_USDC_ADDRESS=${base58(usdcInstance.address)}`);
  console.log(`VITE_TRON_NILE_MANAGER_ADDRESS=${base58(manager.address)}`);

  console.log(`\n--- Add these to .env (repo root, for the keeper) ---`);
  console.log(`TRON_NILE_USDC_ADDRESS=${base58(usdcInstance.address)}`);
  console.log(`TRON_NILE_MANAGER_ADDRESS=${base58(manager.address)}`);

  console.log(`\nVerify on nile.tronscan.org: search for ${base58(manager.address)}`);
};
