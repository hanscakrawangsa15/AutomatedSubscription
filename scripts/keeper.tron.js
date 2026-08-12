require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { TronWeb } = require("tronweb");

// TRON has no eth_* JSON-RPC and no Hardhat network concept, so this keeper
// talks to TronGrid directly via TronWeb instead of reusing scripts/keeper.js
// (which is Hardhat/ethers-specific). Mirrors that script's responsibilities
// — discover subscribers, poll due/overdue status, charge, notify — but the
// event-discovery and contract-call mechanics are TronWeb's own shape.

const POLL_INTERVAL_MS = Number(process.env.KEEPER_POLL_MS || 10_000);
const FULL_HOST = process.env.VITE_TRON_FULL_HOST || "https://nile.trongrid.io";
const FEE_LIMIT = 150_000_000; // 150 TRX cap per contract call

const MANAGER_ADDRESS = process.env.TRON_NILE_MANAGER_ADDRESS;
const USDC_ADDRESS = process.env.TRON_NILE_USDC_ADDRESS;
const PRIVATE_KEY = process.env.TRON_NILE_KEEPER_PRIVATE_KEY || process.env.TRON_NILE_DEPLOYER_PRIVATE_KEY;
// Timestamp (ms) to start scanning events from — set this to roughly the
// deploy time to avoid re-scanning all of Nile's history on every startup.
const DEPLOY_TIMESTAMP_MS = Number(process.env.TRON_NILE_MANAGER_DEPLOY_TIMESTAMP_MS || 0);

if (!MANAGER_ADDRESS || !USDC_ADDRESS) {
  throw new Error(
    "TRON_NILE_MANAGER_ADDRESS and TRON_NILE_USDC_ADDRESS must be set in .env " +
      "(see the values printed by `npm run deploy:tron-nile`).",
  );
}
if (!PRIVATE_KEY) {
  throw new Error(
    "TRON_NILE_KEEPER_PRIVATE_KEY (or TRON_NILE_DEPLOYER_PRIVATE_KEY as a fallback) must be set in .env — " +
      "the keeper needs a funded TRX wallet to pay for chargeDue/retryCharge/expireOverdue calls.",
  );
}

// Built by `npx tronbox compile` (see tron/tronbox.js) — the JSON ABI here
// is TVM-solc's own output, kept as the source of truth for the Tron side
// rather than hand-porting the ethers human-readable ABI used by the EVM
// keeper (frontend/src/abi/SubscriptionManager.ts), since the two compilers
// are entirely separate pipelines and could in principle drift.
const managerArtifact = require(path.join(__dirname, "..", "tron", "build", "contracts", "SubscriptionManager.json"));
const usdcArtifact = require(path.join(__dirname, "..", "tron", "build", "contracts", "MockUSDC.json"));

const tronWeb = new TronWeb({ fullHost: FULL_HOST, privateKey: PRIVATE_KEY });

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || "onboarding@resend.dev";
const SUBSCRIBERS_FILE = path.join(__dirname, "..", "server", "subscribers.json");

let warnedNoApiKey = false;

function loadSubscriberEmail(address) {
  if (!fs.existsSync(SUBSCRIBERS_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, "utf8"));
    // TRON addresses are case-sensitive base58 — looked up as-is, unlike
    // the EVM keeper's lowercase hex lookup (see server/index.js).
    return data[address] || null;
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

// A decoded TRON event's indexed address params can come back as either
// hex ("41...") or base58 ("T...") depending on the node — normalize to
// base58 so it matches what the frontend/subscribers.json use everywhere.
function toBase58(address) {
  if (typeof address === "string" && address.startsWith("T")) return address;
  return tronWeb.address.fromHex(address);
}

// TronGrid's event API is timestamp/fingerprint-paginated, not block-range
// chunked like eth_getLogs — a different shape from keeper.js's
// queryLogsChunked, not a port of it.
async function fetchAllEvents(contractAddress, eventName, minBlockTimestamp) {
  const results = [];
  let fingerprint;
  for (;;) {
    const res = await tronWeb.getEventResult(contractAddress, {
      eventName,
      minBlockTimestamp,
      orderBy: "block_timestamp,asc",
      limit: 200,
      fingerprint,
    });
    const page = res.data || [];
    results.push(...page);
    if (!res.meta?.fingerprint || page.length === 0) break;
    fingerprint = res.meta.fingerprint;
  }
  return results;
}

const manager = tronWeb.contract(managerArtifact.abi, MANAGER_ADDRESS);
const usdc = tronWeb.contract(usdcArtifact.abi, USDC_ADDRESS);

async function main() {
  // Catches the "stale .env value from a different chain/redeploy" class of
  // mistake before it produces confusing downstream revert errors — mirrors
  // the getCode() sanity check in scripts/keeper.js, but via a real call
  // since TronWeb's contract-existence introspection response shape isn't
  // as reliably documented as a plain getCode check would be on EVM.
  try {
    await manager.owner().call();
  } catch (err) {
    throw new Error(
      `Could not read owner() from ${MANAGER_ADDRESS} on Nile — TRON_NILE_MANAGER_ADDRESS in .env likely ` +
        `points at the wrong network or hasn't been deployed yet (run \`npm run deploy:tron-nile\`). ` +
        `Underlying error: ${err.message || err}`,
    );
  }

  const decimals = await usdc.decimals().call();

  const keeperAddress = tronWeb.defaultAddress.base58;
  console.log(`Keeper running as ${keeperAddress} on TRON Nile testnet`);
  console.log(`Watching ${MANAGER_ADDRESS}, polling every ${POLL_INTERVAL_MS / 1000}s. Ctrl+C to stop.\n`);

  const knownUsers = new Set();
  let lastScannedTimestamp = DEPLOY_TIMESTAMP_MS;

  const scanForUsers = async (minTimestamp) => {
    const [subscribed, reactivated] = await Promise.all([
      fetchAllEvents(MANAGER_ADDRESS, "Subscribed", minTimestamp),
      fetchAllEvents(MANAGER_ADDRESS, "Reactivated", minTimestamp),
    ]);
    for (const ev of [...subscribed, ...reactivated]) {
      knownUsers.add(toBase58(ev.result.user));
    }
  };

  const initialScan = async () => {
    console.log(`Scanning for subscribers since ${new Date(lastScannedTimestamp).toISOString()}...`);
    await scanForUsers(lastScannedTimestamp);
    lastScannedTimestamp = Date.now();
    console.log(`Found ${knownUsers.size} known subscriber(s).\n`);
  };

  const discoverUsers = async () => {
    const now = Date.now();
    await scanForUsers(lastScannedTimestamp);
    lastScannedTimestamp = now;
  };

  const notifyIfRegistered = async (user, sub, txHash) => {
    const email = loadSubscriberEmail(user);
    if (!email) return;
    const plan = await manager.plans(sub.planId).call();
    await sendReceiptEmail({
      to: email,
      amountLabel: `${(Number(plan.price) / 10 ** Number(decimals)).toString()} USDT`,
      plan: planLabel(Number(plan.interval)),
      nextChargeAt: new Date(Number(sub.nextChargeAt) * 1000).toLocaleString(),
      txHash,
    });
  };

  const tick = async () => {
    await discoverUsers();

    for (const user of knownUsers) {
      const sub = await manager.subscriptions(user).call();
      const status = Number(sub.status);
      const time = new Date().toLocaleTimeString();

      try {
        if (status === 1 && (await manager.isDue(user).call())) {
          const result = await manager.chargeDue(user).send({ feeLimit: FEE_LIMIT, shouldPollResponse: true });
          const txHash = typeof result === "string" ? result : result.id || result.txid || "";
          console.log(`[${time}] chargeDue(${user}) OK`);
          const updated = await manager.subscriptions(user).call();
          await notifyIfRegistered(user, updated, txHash);
        } else if (status === 2) {
          try {
            const result = await manager.retryCharge(user).send({ feeLimit: FEE_LIMIT, shouldPollResponse: true });
            const txHash = typeof result === "string" ? result : result.id || result.txid || "";
            console.log(`[${time}] retryCharge(${user}) OK`);
            const updated = await manager.subscriptions(user).call();
            await notifyIfRegistered(user, updated, txHash);
          } catch {
            const plan = await manager.plans(sub.planId).call();
            const nowBlock = await tronWeb.trx.getCurrentBlock();
            const nowSeconds = Math.floor(nowBlock.block_header.raw_data.timestamp / 1000);
            if (nowSeconds >= Number(sub.overdueSince) + Number(plan.gracePeriod)) {
              await manager.expireOverdue(user).send({ feeLimit: FEE_LIMIT, shouldPollResponse: true });
              console.log(`[${time}] expireOverdue(${user}) OK`);
            }
          }
        }
      } catch (err) {
        console.error(`[${time}] action failed for ${user}:`, err.message || err);
      }
    }
  };

  await initialScan();
  await tick();
  setInterval(() => {
    tick().catch((err) => console.error("Keeper tick failed:", err.message || err));
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
