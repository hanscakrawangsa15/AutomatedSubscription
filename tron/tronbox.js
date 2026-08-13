// TronBox config for deploying SubscriptionManager (and the shared MockUSDC
// test token) to TRON Nile testnet. Kept separate from hardhat.config.js —
// Tron has no eth_* JSON-RPC, so Hardhat's `networks` block cannot target it.
//
// Get testnet TRX for the deployer address from https://nileex.io/join/getJoinPage
// before running `npm run migrate:nile` (needed for deploy gas).
require("dotenv").config({ path: "../.env" });

module.exports = {
  // TronBox requires contracts_directory to be inside the project — this is
  // a symlink to the shared ../contracts folder (created via `ln -s`), not a
  // copy, so SubscriptionManager.sol/MockUSDC.sol still have one real source.
  contracts_directory: "./contracts",
  contracts_build_directory: "./build/contracts",
  migrations_directory: "./migrations",

  networks: {
    nile: {
      privateKey: process.env.TRON_NILE_DEPLOYER_PRIVATE_KEY,
      userFeePercentage: 100,
      feeLimit: 1000 * 1e6, // 1000 TRX
      fullHost: "https://nile.trongrid.io",
      network_id: "3",
    },
    // Mainnet — REAL FUNDS. No public-RPC fallback distinction needed here
    // (api.trongrid.io is TronGrid's own mainnet endpoint, same pattern as
    // the frontend's default), but the deployer key must be explicitly set
    // — no shared/fallback key, unlike some of the testnet scripts.
    mainnet: {
      privateKey: process.env.TRON_MAINNET_DEPLOYER_PRIVATE_KEY,
      userFeePercentage: 100,
      feeLimit: 1000 * 1e6, // 1000 TRX
      fullHost: "https://api.trongrid.io",
      network_id: "1",
    },
  },

  compilers: {
    solc: {
      version: "0.8.24",
      settings: {
        optimizer: { enabled: true, runs: 200 },
      },
    },
  },
};
