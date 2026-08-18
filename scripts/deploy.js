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

  if (isProduction && process.env.CONFIRM_MAINNET_DEPLOY !== "yes-i-am-sure") {
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

  const SubscriptionManager = await hre.ethers.getContractFactory("SubscriptionManager");
  const manager = await SubscriptionManager.deploy(usdcAddress, deployer.address);
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
    await (await manager.createPlan(hre.ethers.parseUnits("10", decimals), 30 * DAY, 5 * DAY)).wait();
    console.log("Created Monthly plan: 10 tokens / 30 days, 5 day grace period");

    await (await manager.createPlan(hre.ethers.parseUnits("100", decimals), 365 * DAY, 10 * DAY)).wait();
    console.log("Created Yearly plan: 100 tokens / 365 days, 10 day grace period");
  } else {
    console.log("Skipping default Monthly/Yearly plans — run scripts/create-plans-safe.js next for the real tiers.");
  }

  if (!isProduction) {
    await (await manager.createPlan(hre.ethers.parseUnits("1", decimals), 3 * MINUTE, 2 * MINUTE)).wait();
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

  if (isProduction) {
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
