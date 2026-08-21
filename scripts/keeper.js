require("dotenv").config();
const hre = require("hardhat");
const { lookupSubscriberEmail, updateRenewalInfo, reconcileMissingSubscriber } = require("./subscribersDb");
const { sendEmail } = require("./emailClient");

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
  await sendEmail({
    to,
    subject: `Subscription renewed — ${amountLabel} charged`,
    html: `<p>Your <strong>${plan}</strong> subscription was renewed.</p>
<p><strong>Amount:</strong> ${amountLabel}</p>
<p><strong>Next charge:</strong> ${nextChargeAt}</p>
<p><strong>Transaction:</strong> ${txHash}</p>`,
  });
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
  const chainName = chainNameFor(chainId);
  // Mirrors the contract's Status enum — see server/index.js's
  // SUBSCRIPTION_STATUSES for the admin-panel-facing side of this mapping.
  const STATUS_LABELS = { 0: "inactive", 1: "active", 2: "overdue", 3: "expired" };

  const scanForUsers = async (fromBlock, toBlock) => {
    const [subscribed, reactivated] = await Promise.all([
      queryLogsChunked(manager, manager.filters.Subscribed(), fromBlock, toBlock),
      queryLogsChunked(manager, manager.filters.Reactivated(), fromBlock, toBlock),
    ]);
    const events = [...subscribed, ...reactivated];
    for (const ev of events) {
      knownUsers.add(ev.args.user);
    }
    // Self-healing: reconciles any wallet this on-chain event proves
    // subscribed, but whose DB row somehow never showed up (see
    // reconcileMissingSubscriber's doc comment for the real incident this
    // covers). Runs on every scan — the initial full historical scan on
    // keeper startup catches any pre-existing gap, the ongoing incremental
    // scan catches a fresh one within one poll interval. INSERT IGNORE
    // makes this a no-op for the overwhelmingly common case where the
    // client-side write already succeeded.
    for (const ev of events) {
      const user = ev.args.user;
      try {
        const sub = await manager.subscriptions(user);
        const plan = await manager.plans(sub.planId);
        const inserted = await reconcileMissingSubscriber(user.toLowerCase(), chainName, {
          chainId: Number(chainId),
          planId: Number(sub.planId),
          planLabel: planLabel(Number(plan.interval)),
          txHash: ev.transactionHash,
          periodsPaid: Number(sub.periodsPaid),
          nextChargeAtSeconds: Number(sub.nextChargeAt),
          status: STATUS_LABELS[Number(sub.status)] ?? null,
          renewalResult: "success",
        });
        if (inserted) {
          console.log(`Reconciled missing DB row for ${user} on ${chainName} (backfilled from on-chain event)`);
        }
      } catch (err) {
        console.warn(`Reconciliation check failed for ${user}: ${err.message}`);
      }
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

  // Always reflects the contract's current truth into the DB, independent
  // of whether email notification is possible for this subscriber (see
  // notifyIfRegistered below, which wraps this for the two paths that also
  // send a receipt).
  const syncRenewalInfo = async (user, sub, renewalResult) => {
    await updateRenewalInfo(user.toLowerCase(), chainName, {
      periodsPaid: Number(sub.periodsPaid),
      nextChargeAtSeconds: Number(sub.nextChargeAt),
      status: STATUS_LABELS[Number(sub.status)] ?? null,
      renewalResult,
    }).catch((err) => {
      console.warn(`renewal info update failed for ${user}: ${err.message}`);
    });
  };

  const notifyIfRegistered = async (user, sub, txHash, renewalResult) => {
    await syncRenewalInfo(user, sub, renewalResult);

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
          // chargeDue never reverts on insufficient allowance/balance — it
          // silently marks Overdue instead (see the contract) — so a
          // non-reverting tx here does NOT necessarily mean money moved.
          // The resulting status is the only reliable signal.
          const renewalResult = Number(updated.status) === 1 ? "success" : "failed";
          await notifyIfRegistered(user, updated, tx.hash, renewalResult);
        } else if (status === 2) {
          try {
            const tx = await manager.retryCharge(user);
            await tx.wait();
            console.log(`[${time}] retryCharge(${user}) OK`);
            const updated = await manager.subscriptions(user);
            await notifyIfRegistered(user, updated, tx.hash, "success");
          } catch {
            // retryCharge reverts outright on failure (unlike chargeDue) —
            // reaching here means still insufficient allowance/balance.
            await syncRenewalInfo(user, sub, "failed");
            const plan = await manager.plans(sub.planId);
            const block = await hre.ethers.provider.getBlock("latest");
            if (block.timestamp >= Number(sub.overdueSince) + Number(plan.gracePeriod)) {
              const tx = await manager.expireOverdue(user);
              await tx.wait();
              console.log(`[${time}] expireOverdue(${user}) OK`);
              const updated = await manager.subscriptions(user);
              await syncRenewalInfo(user, updated, "failed");
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
