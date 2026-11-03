// Set DRY_RUN=1 (production networks only) to run every check and print what
// WOULD be deployed, without sending a single transaction.
//
// TREASURY_ADDRESS=<Safe address> sets who receives the subscription revenue.
// REQUIRED on production networks, so the deployer's own key can never end up
// as the treasury by omission.
//
// Set TRANSFER_OWNERSHIP_TO=<Safe address> to hand the new manager's ownership
// to the multisig in the same run (verified to be a Safe first), so there is
// no window where a plain deployer key owns a live manager.
const hre = require("hardhat");

const MINUTE = 60;
const DAY = 24 * 60 * 60;
const TEST_ACCOUNT_COUNT = 5;

const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);
const PRODUCTION_NETWORKS = new Set(["base", "mainnet", "bsc"]);

// Used as a sanity guard so a misconfigured RPC_URL can't silently deploy
// this script's logic against the wrong chain (e.g. testnet-shaped mint
// calls hitting a mainnet RPC by accident, or vice versa).
const EXPECTED_CHAIN_IDS = {
  hardhat: 31337n,
  localhost: 31337n,
  baseSepolia: 84532n,
  sepolia: 11155111n,
  bscTestnet: 97n,
  base: 8453n,
  mainnet: 1n,
  bsc: 56n,
};

const EXPLORERS = {
  baseSepolia: "sepolia.basescan.org",
  sepolia: "sepolia.etherscan.io",
  bscTestnet: "testnet.bscscan.com",
  base: "basescan.org",
  mainnet: "etherscan.io",
  bsc: "bscscan.com",
};

const RPC_ENV_VARS = {
  base: "BASE_RPC_URL",
  mainnet: "MAINNET_RPC_URL",
  bsc: "BSC_RPC_URL",
};

// A second (or later, third) payment token on an already-deployed chain is
// a brand new SubscriptionManager instance — paymentToken is immutable, so
// one manager can never serve two tokens. DEPLOY_TOKEN_SUFFIX picks which
// token this run targets; "" (default) is every chain's original/primary
// token and stays 100% behavior-compatible with every prior deploy. The
// suffix is appended to every env var name this script reads/prints, and
// (non-production only) selects which mock contract to deploy — must have
// an entry here for every non-production suffix in use.
const MOCK_CONTRACT_BY_SUFFIX = {
  "": "MockUSDC",
  _USDT: "MockUSDT",
};

async function main() {
  const networkName = hre.network.name;
  const isLocal = LOCAL_NETWORKS.has(networkName);
  const isProduction = PRODUCTION_NETWORKS.has(networkName);
  const tokenSuffix = process.env.DEPLOY_TOKEN_SUFFIX || "";

  if (isProduction && !process.env[RPC_ENV_VARS[networkName]]) {
    throw new Error(
      `${RPC_ENV_VARS[networkName]} is not set in .env. Production networks require an explicit paid ` +
        `RPC URL (Alchemy/Infura/QuickNode) — no public-RPC fallback, by design, for real transaction volume.`,
    );
  }

  const network = await hre.ethers.provider.getNetwork();
  const expectedChainId = EXPECTED_CHAIN_IDS[networkName];
  if (expectedChainId !== undefined && network.chainId !== expectedChainId) {
    throw new Error(
      `Chain ID mismatch for network "${networkName}": RPC reports chainId ${network.chainId}, ` +
        `expected ${expectedChainId}. Check the RPC URL in .env before deploying.`,
    );
  }

  // A dry run sends nothing, so it doesn't need the mainnet confirmation —
  // and leaving it out means forgetting DRY_RUN=1 simply blocks the deploy
  // instead of performing it.
  if (isProduction && process.env.DRY_RUN !== "1" && process.env.CONFIRM_MAINNET_DEPLOY !== "yes-i-am-sure") {
    throw new Error(
      `Refusing to deploy to production network "${networkName}" without confirmation. ` +
        `Set CONFIRM_MAINNET_DEPLOY=yes-i-am-sure in your environment to proceed. This deploys ` +
        `real contracts wired to real USDC — make sure Phase 0-3 of the mainnet plan are done first.`,
    );
  }

  const signers = await hre.ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      `No signer available for network "${networkName}". Set DEPLOYER_PRIVATE_KEY (or a per-network ` +
        `override like BASE_DEPLOYER_PRIVATE_KEY) in .env to a wallet funded with gas on this chain.`,
    );
  }
  const deployer = signers[0];

  const treasuryEnv = process.env.TREASURY_ADDRESS;
  if (treasuryEnv && !hre.ethers.isAddress(treasuryEnv)) {
    throw new Error(`TREASURY_ADDRESS is not a valid address: ${treasuryEnv}`);
  }
  if (isProduction) {
    if (!treasuryEnv) {
      throw new Error(
        "TREASURY_ADDRESS is required on production networks (the Safe multisig that receives revenue) — " +
          "otherwise the deployer's own key would become the treasury.",
      );
    }
    if ((await hre.ethers.provider.getCode(treasuryEnv)) === "0x") {
      throw new Error(`TREASURY_ADDRESS ${treasuryEnv} has no contract code on ${networkName} — expected a Safe.`);
    }
  }
  const treasuryAddress = treasuryEnv || deployer.address;

  console.log(
    `Deploying to ${networkName} (chainId ${network.chainId}) as ${deployer.address}` +
      (tokenSuffix ? ` [token suffix: ${tokenSuffix}]` : ""),
  );

  const mockContractName = MOCK_CONTRACT_BY_SUFFIX[tokenSuffix];
  if (!isProduction && !mockContractName) {
    throw new Error(
      `No mock contract mapped for DEPLOY_TOKEN_SUFFIX=${tokenSuffix} in MOCK_CONTRACT_BY_SUFFIX. ` +
        `Add one (e.g. a new contracts/mocks/MockXxx.sol) before deploying this token on a non-production network.`,
    );
  }

  let usdcAddress;
  let decimals;

  if (isProduction) {
    // Never deploy a mock token to a production network. The real token
    // address must be verified out-of-band first (issuer's own docs + the
    // chain's block explorer — see docs/mainnet-addresses.md) and supplied
    // via env, never guessed or hardcoded here.
    const chainId = network.chainId.toString();
    usdcAddress = process.env[`USDC_ADDRESS_${chainId}${tokenSuffix}`];
    if (!usdcAddress) {
      throw new Error(
        `USDC_ADDRESS_${chainId}${tokenSuffix} is not set. Production deploys require a pre-verified real ` +
          `token address for this chain (never auto-deployed) — see docs/mainnet-addresses.md.`,
      );
    }
    const usdcRead = new hre.ethers.Contract(
      usdcAddress,
      ["function decimals() view returns (uint8)"],
      hre.ethers.provider,
    );
    decimals = await usdcRead.decimals();
    console.log(`Using existing token at ${usdcAddress} (decimals=${decimals})`);
  } else {
    const MockUSDC = await hre.ethers.getContractFactory(mockContractName);
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();
    usdcAddress = await usdc.getAddress();
    decimals = await usdc.decimals();
    console.log(`${mockContractName} deployed to ${usdcAddress}`);
  }

  if (process.env.DRY_RUN === "1") {
    if (!isProduction) throw new Error("DRY_RUN=1 is only supported for production networks.");
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    const ownerTarget = process.env.TRANSFER_OWNERSHIP_TO;
    console.log(
      `\nDRY_RUN=1 — nothing deployed. On a real run this would:\n` +
        `  - deploy SubscriptionManager(paymentToken=${usdcAddress}, treasury=${treasuryAddress}) on ${networkName}\n` +
        `  - env suffix: "${tokenSuffix}"  (keys: USDC_ADDRESS_${network.chainId}${tokenSuffix}, SUBSCRIPTION_MANAGER_ADDRESS_${network.chainId}${tokenSuffix})\n` +
        `  - ${ownerTarget ? `transfer ownership to ${ownerTarget}` : "NOT transfer ownership (TRANSFER_OWNERSHIP_TO unset)"}\n` +
        `  deployer gas balance: ${hre.ethers.formatEther(balance)}`,
    );
    return;
  }

  const SubscriptionManager = await hre.ethers.getContractFactory("SubscriptionManager");
  const manager = await SubscriptionManager.deploy(usdcAddress, treasuryAddress);
  await manager.waitForDeployment();
  const managerAddress = await manager.getAddress();
  const deployBlock = manager.deploymentTransaction()?.blockNumber ?? (await hre.ethers.provider.getBlockNumber());
  console.log(`SubscriptionManager deployed to ${managerAddress} (block ${deployBlock})`);

  // A second token on an already-live chain gets its 5-tier plan set
  // created via scripts/create-plans-safe.js afterward (matching how the
  // original USDC managers' Basic/Advance tiers were added), not these
  // generic Monthly/Yearly placeholders — skip them here to avoid leaving
  // stray plans nobody references.
  const skipDefaultPlans = isProduction && tokenSuffix !== "";
  if (!skipDefaultPlans) {
    await (await manager.createPlan(hre.ethers.parseUnits("10", decimals), 30 * DAY, 5 * DAY, 0)).wait();
    console.log("Created Monthly plan: 10 tokens / 30 days, 5 day grace period");

    await (await manager.createPlan(hre.ethers.parseUnits("100", decimals), 365 * DAY, 10 * DAY, 0)).wait();
    console.log("Created Yearly plan: 100 tokens / 365 days, 10 day grace period");
  } else {
    console.log("Skipping default Monthly/Yearly plans — run scripts/create-plans-safe.js next for the real tiers.");
  }

  if (!isProduction) {
    await (await manager.createPlan(hre.ethers.parseUnits("1", decimals), 3 * MINUTE, 2 * MINUTE, 0)).wait();
    console.log("Created Test plan: 1 token / 3 minutes, 2 minute grace period (for fast renewal testing)");
  }

  if (isLocal) {
    const usdc = await hre.ethers.getContractAt(mockContractName, usdcAddress, deployer);
    const testAccounts = signers.slice(0, TEST_ACCOUNT_COUNT);
    for (const account of testAccounts) {
      await (await usdc.mint(account.address, hre.ethers.parseUnits("100000", decimals))).wait();
    }
    console.log(`Minted 100,000 test tokens to local accounts #0-#${testAccounts.length - 1}`);
  } else if (!isProduction) {
    // Real testnets only have the one deployer key configured — mint to
    // yourself only. The mock's mint() is public, so anyone can self-serve
    // more from the app's Dev Tools faucet afterward.
    const usdc = await hre.ethers.getContractAt(mockContractName, usdcAddress, deployer);
    await (await usdc.mint(deployer.address, hre.ethers.parseUnits("100000", decimals))).wait();
    console.log(`Minted 100,000 test tokens to deployer ${deployer.address}`);
  }
  // Production: never mint — real tokens have no public mint, and this
  // branch is intentionally skipped rather than left to fail at runtime.

  const chainId = network.chainId.toString();
  console.log(`\n--- Add these to frontend/.env (keyed by chainId ${chainId}${tokenSuffix}) ---`);
  console.log(`VITE_USDC_ADDRESS_${chainId}${tokenSuffix}=${usdcAddress}`);
  console.log(`VITE_SUBSCRIPTION_MANAGER_ADDRESS_${chainId}${tokenSuffix}=${managerAddress}`);

  console.log(`\n--- Add these to .env (repo root, for the keeper) ---`);
  console.log(`USDC_ADDRESS_${chainId}${tokenSuffix}=${usdcAddress}`);
  console.log(`SUBSCRIPTION_MANAGER_ADDRESS_${chainId}${tokenSuffix}=${managerAddress}`);
  console.log(`SUBSCRIPTION_MANAGER_DEPLOY_BLOCK_${chainId}${tokenSuffix}=${deployBlock}`);

  if (isLocal) {
    console.log("\n--- MetaMask setup ---");
    console.log("Add network: RPC http://127.0.0.1:8545, Chain ID 31337, Currency ETH");
    console.log("Import a private key from the `npx hardhat node` terminal output (accounts #0-#4 hold test USDC).");
  } else if (EXPLORERS[networkName]) {
    console.log(`\nVerify on ${EXPLORERS[networkName]}: search for ${managerAddress}`);
  }

  const ownerTarget = process.env.TRANSFER_OWNERSHIP_TO;
  if (ownerTarget) {
    if (!hre.ethers.isAddress(ownerTarget)) throw new Error(`TRANSFER_OWNERSHIP_TO is not an address: ${ownerTarget}`);
    if (isProduction) {
      // A plain Ownable transfer is instant and irreversible — make sure the
      // target is really a Safe (has code and answers getThreshold()) rather
      // than a typo'd EOA that would orphan the contract.
      const safe = new hre.ethers.Contract(
        ownerTarget,
        ["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"],
        hre.ethers.provider,
      );
      const [threshold, owners] = await Promise.all([safe.getThreshold(), safe.getOwners()]);
      console.log(`Transferring ownership to Safe ${ownerTarget} (${owners.length} owners, threshold ${threshold})...`);
    }
    await (await manager.transferOwnership(ownerTarget)).wait();
    const newOwner = await manager.owner();
    if (newOwner.toLowerCase() !== ownerTarget.toLowerCase()) throw new Error(`Ownership check failed: owner() is ${newOwner}`);
    console.log(`Ownership transferred. owner() = ${newOwner}`);
  }

  if (isProduction && !ownerTarget) {
    console.log(
      "\n⚠ Production deploy complete. Transfer ownership to your Safe multisig NOW " +
        "(transferOwnership) before any real subscriber is invited in — see Phase 2.3 of the mainnet plan.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
