require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const POLL_INTERVAL_MS = Number(process.env.KEEPER_POLL_MS || 10_000);

// Fallback for the local dev chain so `npm run keeper` keeps working without
// any .env changes; every other network must be configured explicitly via
// SUBSCRIPTION_MANAGER_ADDRESS_<chainId> / USDC_ADDRESS_<chainId>.
const LOCAL_CHAIN_DEFAULTS = {
  31337: {
    manager: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    usdc: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  },
};

// Minimal ERC20-metadata ABI — the keeper only needs decimals(). Using a
// generic interface here (rather than typing the token as MockUSDC) keeps
// this script correct against real USDC on mainnet too, not just the mock.
const ERC20_METADATA_ABI = ["function decimals() view returns (uint8)"];

function resolveAddresses(chainId) {
  const manager = process.env[`SUBSCRIPTION_MANAGER_ADDRESS_${chainId}`] || process.env.MANAGER_ADDRESS;
  const usdc = process.env[`USDC_ADDRESS_${chainId}`] || process.env.USDC_ADDRESS;
  const fallback = LOCAL_CHAIN_DEFAULTS[chainId];
  const deployBlock = Number(process.env[`SUBSCRIPTION_MANAGER_DEPLOY_BLOCK_${chainId}`] || 0);
  return {
    manager: manager || fallback?.manager,
    usdc: usdc || fallback?.usdc,
    deployBlock,
  };
}

// Public RPC providers cap how many blocks a single eth_getLogs call can
// span (commonly 10k-50k) — a real testnet has millions of blocks, so
// querying "from block 0" (fine on a young local chain) hard-fails here.
// Chunk through history once at startup instead, starting from the
// contract's deploy block (via SUBSCRIPTION_MANAGER_DEPLOY_BLOCK_<chainId>)
// rather than genesis, then only poll the small delta of new blocks per tick.
const CHUNK_SIZE = 10_000;

async function queryLogsChunked(contract, filter, fromBlock, toBlock) {
  const results = [];
  let chunkSize = CHUNK_SIZE;
  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(from + chunkSize - 1, toBlock);
    try {
      const logs = await contract.queryFilter(filter, from, to);
      results.push(...logs);
      from = to + 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/block range|exceed/i.test(message) && chunkSize > 500) {
        chunkSize = Math.floor(chunkSize / 4);
        continue;
      }
      throw err;
    }
  }
  return results;
}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || "onboarding@resend.dev";
const SUBSCRIBERS_FILE = path.join(__dirname, "..", "server", "subscribers.json");

let warnedNoApiKey = false;

function loadSubscriberEmail(address) {
  if (!fs.existsSync(SUBSCRIBERS_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, "utf8"));
    return data[address.toLowerCase()] || null;
  } catch {
    return null;
  }
}

function planLabel(intervalSeconds) {
  const days = intervalSeconds / 86400;
  if (days >= 25 && days <= 45) return "Monthly";
  if (days >= 300 && days <= 400) return "Yearly";
  if (days < 1) return "Test";
  return "Plan";
}

async function sendReceiptEmail({ to, amountLabel, plan, nextChargeAt, txHash }) {
  if (!RESEND_API_KEY) {
    if (!warnedNoApiKey) {
      console.warn("RESEND_API_KEY not set — skipping email notifications (see .env.example)");
      warnedNoApiKey = true;
    }
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to,
        subject: `Subscription renewed — ${amountLabel} charged`,
        html: `<p>Your <strong>${plan}</strong> subscription was renewed.</p>
<p><strong>Amount:</strong> ${amountLabel}</p>
<p><strong>Next charge:</strong> ${nextChargeAt}</p>
<p><strong>Transaction:</strong> ${txHash}</p>`,
      }),
    });
    if (!res.ok) {
      console.error(`Email send failed (${res.status}):`, await res.text());
    } else {
      console.log(`Email sent to ${to}`);
    }
  } catch (err) {
    console.error("Email send failed:", err.message);
  }
}

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  const chainId = network.chainId.toString();
  const { manager: managerAddress, usdc: usdcAddress, deployBlock } = resolveAddresses(chainId);

  if (!managerAddress || !usdcAddress) {
    throw new Error(
      `No contract addresses configured for chain ${chainId}. Set SUBSCRIPTION_MANAGER_ADDRESS_${chainId} ` +
        `and USDC_ADDRESS_${chainId} in .env (see the values printed by \`npm run deploy:*\`).`,
    );
  }

  // Catches the "stale .env value from a different chain" class of mistake
  // — e.g. a Sepolia address left in place after switching to a mainnet
  // run — before it produces confusing downstream revert errors.
  const managerCode = await hre.ethers.provider.getCode(managerAddress);
  if (managerCode === "0x") {
    throw new Error(
      `No contract found at ${managerAddress} on chain ${chainId} — SUBSCRIPTION_MANAGER_ADDRESS_${chainId} ` +
        `in .env likely points at the wrong network.`,
    );
  }

  const [keeper] = await hre.ethers.getSigners();
  const manager = await hre.ethers.getContractAt("SubscriptionManager", managerAddress, keeper);
  const usdc = new hre.ethers.Contract(usdcAddress, ERC20_METADATA_ABI, keeper);
  const decimals = await usdc.decimals();

  console.log(`Keeper running as ${keeper.address} on chainId ${chainId}`);
  console.log(`Watching ${managerAddress}, polling every ${POLL_INTERVAL_MS / 1000}s. Ctrl+C to stop.\n`);

  const knownUsers = new Set();
  let lastScannedBlock = null;

  const scanForUsers = async (fromBlock, toBlock) => {
    const [subscribed, reactivated] = await Promise.all([
      queryLogsChunked(manager, manager.filters.Subscribed(), fromBlock, toBlock),
      queryLogsChunked(manager, manager.filters.Reactivated(), fromBlock, toBlock),
    ]);
    for (const ev of [...subscribed, ...reactivated]) {
      knownUsers.add(ev.args.user);
    }
  };

  const initialScan = async () => {
    const latest = await hre.ethers.provider.getBlockNumber();
    console.log(`Scanning for subscribers from block ${deployBlock} to ${latest}...`);
    await scanForUsers(deployBlock, latest);
    lastScannedBlock = latest;
    console.log(`Found ${knownUsers.size} known subscriber(s).\n`);
  };

  const discoverUsers = async () => {
    const latest = await hre.ethers.provider.getBlockNumber();
    if (latest <= lastScannedBlock) return;
    await scanForUsers(lastScannedBlock + 1, latest);
    lastScannedBlock = latest;
  };

  const notifyIfRegistered = async (user, sub, txHash) => {
    const email = loadSubscriberEmail(user);
    if (!email) return;
    const plan = await manager.plans(sub.planId);
    await sendReceiptEmail({
      to: email,
      amountLabel: `${hre.ethers.formatUnits(plan.price, decimals)} USDC`,
      plan: planLabel(Number(plan.interval)),
      nextChargeAt: new Date(Number(sub.nextChargeAt) * 1000).toLocaleString(),
      txHash,
    });
  };

  const tick = async () => {
    await discoverUsers();

    for (const user of knownUsers) {
      const sub = await manager.subscriptions(user);
      const status = Number(sub.status);
      const time = new Date().toLocaleTimeString();

      try {
        if (status === 1 && (await manager.isDue(user))) {
          const tx = await manager.chargeDue(user);
          await tx.wait();
          console.log(`[${time}] chargeDue(${user}) OK`);
          const updated = await manager.subscriptions(user);
          await notifyIfRegistered(user, updated, tx.hash);
        } else if (status === 2) {
          try {
            const tx = await manager.retryCharge(user);
            await tx.wait();
            console.log(`[${time}] retryCharge(${user}) OK`);
            const updated = await manager.subscriptions(user);
            await notifyIfRegistered(user, updated, tx.hash);
          } catch {
            const plan = await manager.plans(sub.planId);
            const block = await hre.ethers.provider.getBlock("latest");
            if (block.timestamp >= Number(sub.overdueSince) + Number(plan.gracePeriod)) {
              const tx = await manager.expireOverdue(user);
              await tx.wait();
              console.log(`[${time}] expireOverdue(${user}) OK`);
            }
          }
        }
      } catch (err) {
        console.error(`[${time}] action failed for ${user}:`, err.message);
      }
    }
  };

  await initialScan();
  await tick();
  setInterval(() => {
    tick().catch((err) => console.error("Keeper tick failed:", err.message));
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
