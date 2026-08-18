require("dotenv").config();
const hre = require("hardhat");
const { lookupSubscriberEmail } = require("./subscribersDb");

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

// Minimal ERC20-metadata ABI — the keeper needs decimals() and symbol()
// (the latter only for renewal-email copy). Using a generic interface here
// (rather than typing the token as MockUSDC) keeps this script correct
// against any real token on mainnet too, not just the mock.
const ERC20_METADATA_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// A chain can have more than one SubscriptionManager instance now (one per
// payment token — paymentToken is immutable, so a second token means a
// second deployment). KEEPER_TOKEN_SUFFIX picks which one this process
// watches; "" (default) is every chain's original/primary token and is
// 100% behavior-compatible with every prior invocation. Read as part of
// the chainId-keyed env var (not a separate global fallback) so a chain
// whose primary vars are already set doesn't accidentally shadow a second
// process meant for its secondary token.
const TOKEN_SUFFIX = process.env.KEEPER_TOKEN_SUFFIX || "";

function resolveAddresses(chainId) {
  const suffix = TOKEN_SUFFIX;
  const manager =
    process.env[`SUBSCRIPTION_MANAGER_ADDRESS_${chainId}${suffix}`] || (suffix === "" ? process.env.MANAGER_ADDRESS : undefined);
  const usdc =
    process.env[`USDC_ADDRESS_${chainId}${suffix}`] || (suffix === "" ? process.env.USDC_ADDRESS : undefined);
  const fallback = suffix === "" ? LOCAL_CHAIN_DEFAULTS[chainId] : undefined;
  const deployBlock = Number(process.env[`SUBSCRIPTION_MANAGER_DEPLOY_BLOCK_${chainId}${suffix}`] || 0);
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
      if (!/block range|exceed/i.test(message) || chunkSize <= 1) throw err;
      // Some free-tier RPC plans (observed: Alchemy free tier) cap
      // eth_getLogs far below the usual 10k-50k range — as low as 10
      // blocks — and say so directly in the error ("up to a N block
      // range"). Jump straight to that exact size instead of blindly
      // quartering down to it over several failed round-trips.
      const stated = message.match(/up to an? (\d+) block/i);
      chunkSize = stated ? Math.max(1, Number(stated[1])) : Math.max(1, Math.floor(chunkSize / 4));
      continue;
    }
  }
  return results;
}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || "onboarding@resend.dev";

let warnedNoApiKey = false;

// Matches frontend/src/lib/chains.ts's chain_name slugs — must stay in
// sync, since server/index.js writes rows keyed by that exact slug when a
// subscribe() transaction confirms.
const CHAIN_NAMES = { 8453: "base-mainnet", 1: "ethereum-mainnet", 56: "bnb-mainnet" };

function chainNameFor(chainId) {
  return CHAIN_NAMES[Number(chainId)] || `evm-${chainId}`;
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
  const [decimals, tokenSymbol] = await Promise.all([usdc.decimals(), usdc.symbol()]);

  console.log(
    `Keeper running as ${keeper.address} on chainId ${chainId}${TOKEN_SUFFIX ? ` [token suffix: ${TOKEN_SUFFIX}]` : ""} (${tokenSymbol})`,
  );
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

  const chainName = chainNameFor(chainId);

  const notifyIfRegistered = async (user, sub, txHash) => {
    const email = await lookupSubscriberEmail(user.toLowerCase(), chainName).catch((err) => {
      console.warn(`Subscriber email lookup failed for ${user}: ${err.message}`);
      return null;
    });
    if (!email) return;
    const plan = await manager.plans(sub.planId);
    await sendReceiptEmail({
      to: email,
      amountLabel: `${hre.ethers.formatUnits(plan.price, decimals)} ${tokenSymbol}`,
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
