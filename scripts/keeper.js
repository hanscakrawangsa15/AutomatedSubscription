require("dotenv").config();
const hre = require("hardhat");
const { lookupSubscriberEmail, updateRenewalInfo, reconcileMissingSubscriber } = require("./subscribersDb");
const { sendEmail } = require("./emailClient");

// Billing is day-granular and every poll costs paid RPC calls, so the default
// is a relaxed 60s. Local dev with minute-scale test plans can lower it via
// KEEPER_POLL_MS / KEEPER_DISCOVER_MS.
const POLL_INTERVAL_MS = Number(process.env.KEEPER_POLL_MS || 60_000);
// How often to scan the chain for NEW subscribers (getLogs is the priciest
// call here). A new subscriber's first charge is at least one plan interval
// away, so there's no need to find them within seconds.
const DISCOVER_INTERVAL_MS = Number(process.env.KEEPER_DISCOVER_MS || 10 * 60_000);

const DAY = 86_400;
// Charge policy: for each due date D (Subscription.nextChargeAt) the keeper
// makes at most this many attempts — one per day, at D, D+1 day, D+2 days.
const MAX_CHARGE_ATTEMPTS = Number(process.env.KEEPER_MAX_ATTEMPTS || 3);

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
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

// Explicit ABI instead of the compiled artifact, on purpose: the v2 contract
// added a trailing `leadTime` field to Plan, and decoding a v1 manager's
// 4-field plans() result with the 5-field artifact ABI throws. Reading only
// the first four fields works against BOTH versions, and a v1 manager can
// still have live subscribers that need renewing.
const MANAGER_ABI = [
  "function plans(uint256) view returns (uint256 price, uint256 interval, uint256 gracePeriod, bool active)",
  "function subscriptions(address) view returns (uint256 planId, uint8 status, uint256 nextChargeAt, uint256 overdueSince, uint256 periodsPaid)",
  // v2 promo pricing: the price of the user's NEXT payment (differs from
  // plans(sub.planId).price once a promo runs out). Missing on a v1 manager.
  "function nextCharge(address user) view returns (uint256 planId, uint256 price)",
  "function chargeDue(address user)",
  "function expireOverdue(address user)",
  "event Subscribed(address indexed user, uint256 indexed planId, uint256 nextChargeAt)",
  "event Reactivated(address indexed user, uint256 nextChargeAt)",
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
  const manager = new hre.ethers.Contract(managerAddress, MANAGER_ABI, keeper);
  const usdc = new hre.ethers.Contract(usdcAddress, ERC20_METADATA_ABI, keeper);
  const [decimals, tokenSymbol] = await Promise.all([usdc.decimals(), usdc.symbol()]);

  console.log(
    `Keeper running as ${keeper.address} on chainId ${chainId}${TOKEN_SUFFIX ? ` [token suffix: ${TOKEN_SUFFIX}]` : ""} (${tokenSymbol})`,
  );
  console.log(`Watching ${managerAddress}, polling every ${POLL_INTERVAL_MS / 1000}s. Ctrl+C to stop.\n`);

  const knownUsers = new Set();
  // Per-user schedule cache: lets the keeper skip every RPC call for a user
  // until their next due time instead of re-reading them on every poll.
  //   wakeAt   - unix seconds before which nothing needs doing for this user
  //   dueKey   - the nextChargeAt the attempt counter below belongs to
  //   lastSlot - highest attempt day (0-based) already handled for dueKey
  const tracked = new Map();
  const planCache = new Map();
  const getPlan = async (planId) => {
    const key = String(planId);
    // price / interval / gracePeriod are immutable once a plan is created.
    if (!planCache.has(key)) planCache.set(key, await manager.plans(planId));
    return planCache.get(key);
  };
  // Price the contract will actually pull on the next chargeDue(): a promo
  // plan switches to its normal-price successor after its discounted periods,
  // and the funds check below must be against THAT price. A v1 manager has no
  // nextCharge(), so it falls back to the plan's own price (and remembers).
  let hasNextCharge = true;
  const upcomingPrice = async (user, plan) => {
    if (hasNextCharge) {
      try {
        return (await manager.nextCharge(user)).price;
      } catch (err) {
        // Only a missing function means "v1 manager"; a flaky RPC must not
        // permanently downgrade this process to the wrong price.
        if (err.code !== "CALL_EXCEPTION" && err.code !== "BAD_DATA") throw err;
        hasNextCharge = false;
      }
    }
    return plan.price;
  };
  const chainNow = async () => Number((await hre.ethers.provider.getBlock("latest")).timestamp);
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
      // A new Subscribed/Reactivated event means any cached schedule for this
      // user is stale (e.g. cancelled and re-subscribed) — force a re-read.
      tracked.delete(ev.args.user);
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
        const block = await ev.getBlock();
        const inserted = await reconcileMissingSubscriber(user.toLowerCase(), chainName, {
          chainId: Number(chainId),
          planId: Number(sub.planId),
          planLabel: planLabel(Number(plan.interval)),
          txHash: ev.transactionHash,
          periodsPaid: Number(sub.periodsPaid),
          nextChargeAtSeconds: Number(sub.nextChargeAt),
          activatedAtSeconds: Number(block.timestamp),
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

  let lastDiscoverAt = 0;
  const initialScan = async () => {
    lastDiscoverAt = Date.now();
    const latest = await hre.ethers.provider.getBlockNumber();
    console.log(`Scanning for subscribers from block ${deployBlock} to ${latest}...`);
    await scanForUsers(deployBlock, latest);
    lastScannedBlock = latest;
    console.log(`Found ${knownUsers.size} known subscriber(s).\n`);
  };

  const discoverUsers = async () => {
    if (Date.now() - lastDiscoverAt < DISCOVER_INTERVAL_MS) return;
    lastDiscoverAt = Date.now();
    const latest = await hre.ethers.provider.getBlockNumber();
    if (latest <= lastScannedBlock) return;
    await scanForUsers(lastScannedBlock + 1, latest);
    lastScannedBlock = latest;
  };

  // Always reflects the contract's current truth into the DB, independent
  // of whether email notification is possible for this subscriber (see
  // notifyIfRegistered below, which wraps this for the two paths that also
  // send a receipt). activatedAtSeconds is only meaningful — and only ever
  // passed — when a charge genuinely just succeeded (see call sites below);
  // omitted for the failure/expiry paths so the column keeps reflecting the
  // last time the subscription was actually activated rather than getting
  // cleared or backdated by a non-event.
  const syncRenewalInfo = async (user, sub, renewalResult, activatedAtSeconds, txHash) => {
    await updateRenewalInfo(user.toLowerCase(), chainName, {
      periodsPaid: Number(sub.periodsPaid),
      nextChargeAtSeconds: Number(sub.nextChargeAt),
      activatedAtSeconds: activatedAtSeconds ?? null,
      txHash: txHash ?? null,
      status: STATUS_LABELS[Number(sub.status)] ?? null,
      renewalResult,
    }).catch((err) => {
      console.warn(`renewal info update failed for ${user}: ${err.message}`);
    });
  };

  const notifyIfRegistered = async (user, sub, txHash, renewalResult, activatedAtSeconds) => {
    await syncRenewalInfo(user, sub, renewalResult, activatedAtSeconds, txHash);

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

  // Moves an Overdue user to Expired once their grace period is over (the
  // contract's version of "cancel the subscription"). With a 0-day grace plan
  // this happens in the same tick as the final failed attempt.
  const expireIfGraceOver = async (user, sub, now, entry) => {
    const plan = await getPlan(sub.planId);
    const expireAt = Number(sub.overdueSince) + Number(plan.gracePeriod);
    if (now < expireAt) {
      entry.wakeAt = expireAt;
      return;
    }
    const tx = await manager.expireOverdue(user);
    await tx.wait();
    console.log(`[${new Date().toLocaleTimeString()}] expireOverdue(${user}) OK — subscription cancelled`);
    await syncRenewalInfo(user, await manager.subscriptions(user), "failed");
    tracked.delete(user);
    knownUsers.delete(user);
  };

  // Renewal policy, per due date D = nextChargeAt:
  //   - attempt k (k = 1..MAX_CHARGE_ATTEMPTS) happens on day D + (k-1) days;
  //   - each attempt first reads the user's allowance + balance itself. If
  //     both cover the price, chargeDue() runs immediately; if not, nothing is
  //     sent on-chain (the contract would mark the user Overdue on the very
  //     first failure) and the keeper just tries again the next day;
  //   - on the last attempt an unfunded user is passed to chargeDue() anyway
  //     so the contract flips them to Overdue, and the subscription is then
  //     expired (immediately for a 0-day grace plan, else once grace ends).
  // Time comes from the chain (block.timestamp), the same clock the contract
  // uses to decide whether a charge is due.
  const processUser = async (user, now) => {
    let entry = tracked.get(user);
    if (!entry) {
      entry = { wakeAt: 0, dueKey: null, lastSlot: -1 };
      tracked.set(user, entry);
    }
    if (entry.wakeAt > now) return;

    const sub = await manager.subscriptions(user);
    const status = Number(sub.status);
    if (status !== 1 && status !== 2) {
      // Inactive / Expired — nothing to charge until a new Subscribed event.
      tracked.delete(user);
      knownUsers.delete(user);
      return;
    }
    if (status === 2) return expireIfGraceOver(user, sub, now, entry);

    const due = Number(sub.nextChargeAt);
    if (due !== entry.dueKey) {
      entry.dueKey = due;
      entry.lastSlot = -1;
    }
    if (now < due) {
      entry.wakeAt = due;
      return;
    }

    const slot = Math.floor((now - due) / DAY);
    if (slot <= entry.lastSlot) {
      entry.wakeAt = due + (entry.lastSlot + 1) * DAY;
      return;
    }

    const plan = await getPlan(sub.planId);
    const isFinal = slot >= MAX_CHARGE_ATTEMPTS - 1;
    const attemptNo = Math.min(slot + 1, MAX_CHARGE_ATTEMPTS);
    const time = new Date().toLocaleTimeString();
    const [allowance, balance, price] = await Promise.all([
      usdc.allowance(user, managerAddress),
      usdc.balanceOf(user),
      upcomingPrice(user, plan),
    ]);
    const funded = allowance >= price && balance >= price;
    entry.lastSlot = slot;
    entry.wakeAt = due + (slot + 1) * DAY;

    if (!funded && !isFinal) {
      const reason = allowance < price ? "allowance" : "balance";
      console.log(`[${time}] ${user}: attempt ${attemptNo}/${MAX_CHARGE_ATTEMPTS} skipped — insufficient ${reason}, retrying tomorrow`);
      await syncRenewalInfo(user, sub, "failed");
      return;
    }

    try {
      const tx = await manager.chargeDue(user);
      const receipt = await tx.wait();
      const updated = await manager.subscriptions(user);
      // Money moved iff periodsPaid went up. An Active status alone proves
      // nothing: on v2 a failed charge inside the retry window leaves the
      // user Active (the contract only emits ChargeFailed).
      if (Number(updated.periodsPaid) > Number(sub.periodsPaid)) {
        console.log(`[${time}] chargeDue(${user}) OK (attempt ${attemptNo}/${MAX_CHARGE_ATTEMPTS})`);
        entry.wakeAt = Number(updated.nextChargeAt);
        const activatedAtSeconds = Number((await receipt.getBlock()).timestamp);
        await notifyIfRegistered(user, updated, tx.hash, "success", activatedAtSeconds);
      } else if (Number(updated.status) === 2) {
        console.log(`[${time}] ${user}: attempt ${attemptNo}/${MAX_CHARGE_ATTEMPTS} failed — marked Overdue`);
        await syncRenewalInfo(user, updated, "failed");
        await expireIfGraceOver(user, updated, await chainNow(), entry);
      } else {
        // Charge didn't go through but the contract kept the user Active
        // (still inside the retry window) — counts as this day's attempt.
        console.log(`[${time}] ${user}: attempt ${attemptNo}/${MAX_CHARGE_ATTEMPTS} failed on-chain, retrying tomorrow`);
        await syncRenewalInfo(user, updated, "failed");
      }
    } catch (err) {
      if (/not due yet/i.test(err.message)) {
        // Our clock view was a block ahead of the contract's — not a real attempt.
        entry.lastSlot = slot - 1;
        entry.wakeAt = now + 1;
        return;
      }
      console.error(`[${time}] charge attempt ${attemptNo}/${MAX_CHARGE_ATTEMPTS} errored for ${user}:`, err.message);
    }
  };

  const tick = async () => {
    await discoverUsers();
    const now = await chainNow();
    for (const user of [...knownUsers]) {
      try {
        await processUser(user, now);
      } catch (err) {
        console.error(`[${new Date().toLocaleTimeString()}] action failed for ${user}:`, err.message);
      }
    }
  };

  await initialScan();
  // A sequential loop (not setInterval): a slow tick can never overlap the
  // next one and collide on the keeper's nonce.
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error("Keeper tick failed:", err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
