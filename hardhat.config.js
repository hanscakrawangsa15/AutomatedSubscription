require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

// Each network can use its own deployer key (e.g. BSC_TESTNET_DEPLOYER_PRIVATE_KEY)
// so you don't have to swap DEPLOYER_PRIVATE_KEY back and forth between accounts
// that hold gas on different chains — it falls back to the shared key if unset.
function accountsFor(envVarName) {
  const key = process.env[envVarName] || process.env.DEPLOYER_PRIVATE_KEY;
  return key ? [key] : [];
}

/** @type {import("hardhat/config").HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      // Without this, block.timestamp never advances unless a transaction
      // is sent — a keeper polling isDue() would see a frozen clock forever
      // once caught up, since it only submits a tx when something is due.
      mining: {
        auto: true,
        interval: 5000,
      },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    // Public testnets. Each needs a deployer key set in .env (a wallet
    // funded with that chain's testnet gas token from a faucet) before you
    // can run `npm run deploy:<network>`. RPC URLs default to public
    // endpoints; override via env if you have your own (Alchemy/Infura/etc).
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: accountsFor("BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY"),
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: accountsFor("SEPOLIA_DEPLOYER_PRIVATE_KEY"),
    },
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC_URL || "https://bsc-testnet-rpc.publicnode.com",
      chainId: 97,
      accounts: accountsFor("BSC_TESTNET_DEPLOYER_PRIVATE_KEY"),
    },
    // Mainnets — REAL FUNDS. Unlike testnets above, there is no public-RPC
    // fallback here on purpose: a paid provider (Alchemy/Infura/QuickNode)
    // is required for production reliability, so a missing *_RPC_URL should
    // fail loudly (see deploy.js's production-network guard) rather than
    // silently falling back to a free endpoint for real transaction volume.
    base: {
      url: process.env.BASE_RPC_URL || "",
      chainId: 8453,
      accounts: accountsFor("BASE_DEPLOYER_PRIVATE_KEY"),
    },
    mainnet: {
      url: process.env.MAINNET_RPC_URL || "",
      chainId: 1,
      accounts: accountsFor("MAINNET_DEPLOYER_PRIVATE_KEY"),
    },
    bsc: {
      url: process.env.BSC_RPC_URL || "",
      chainId: 56,
      accounts: accountsFor("BSC_DEPLOYER_PRIVATE_KEY"),
    },
  },
  // For `npx hardhat verify --network <name> <address>` — publishes source
  // so anyone can confirm the deployed bytecode matches this repo, rather
  // than trusting an opaque blob. Etherscan's V2 API unifies Etherscan/
  // BaseScan/BscScan/etc. under one API key (the old per-network apiKey
  // object is deprecated) — hence the single ETHERSCAN_API_KEY here even
  // though it verifies on all three explorer families.
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
};
