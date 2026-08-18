// Solana keeper — same responsibilities as scripts/keeper.js/keeper.tron.js
// (discover subscribers -> poll due/overdue -> charge/retry/expire ->
// email receipt), but discovery uses getProgramAccounts + memcmp filters
// (via Anchor's program.account.subscription.all()) instead of scanning
// event logs, since Solana has no eth_getLogs-style indexed-event query.
// One transaction per user, deliberately — see the plan doc: Solana's
// whole-transaction atomicity means batching multiple users' charges into
// one transaction would turn one user's routine insufficient-funds event
// into an aborted charge for everyone batched alongside them.
require("dotenv").config();
const os = require("os");
const path = require("path");
const fs = require("fs");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey } = require("@solana/web3.js");
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const bs58 = require("bs58");
const { lookupSubscriberEmail } = require("./subscribersDb");

const POLL_INTERVAL_MS = Number(process.env.KEEPER_POLL_MS || 10_000);

const NETWORK_MODE = (process.env.SOLANA_NETWORK_MODE || "devnet").toLowerCase();
const RPC_URL = process.env[`SOLANA_${NETWORK_MODE.toUpperCase()}_RPC_URL`];
const PROGRAM_ID = process.env[`SOLANA_${NETWORK_MODE.toUpperCase()}_PROGRAM_ID`];
const CONFIG_ADDRESS = process.env[`SOLANA_${NETWORK_MODE.toUpperCase()}_CONFIG`];
const KEEPER_KEYPAIR_PATH =
  process.env.SOLANA_KEEPER_KEYPAIR_PATH || path.join(os.homedir(), ".config/solana/id.json");

// SubStatus enum order from programs/subscription-manager/src/state.rs —
// Inactive=0, Active=1, Overdue=2, Expired=3 (matches Solidity's Status enum).
const STATUS_ACTIVE = 1;
const STATUS_OVERDUE = 2;

// Byte offset of each field within a Subscription account's raw data,
// INCLUDING Anchor's 8-byte discriminator prefix — must stay in sync with
// the field order in state.rs's Subscription struct.
const SUBSCRIPTION_LAYOUT = {
  user: 8,
  config: 40,
  planId: 72,
  status: 80,
  nextChargeAt: 81,
};

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || "onboarding@resend.dev";
// Matches frontend/src/lib/chains.ts's chain_name slugs.
const CHAIN_NAME = NETWORK_MODE === "mainnet" ? "solana-mainnet" : "solana-devnet";

let warnedNoApiKey = false;

// Solana addresses are case-sensitive base58 and are looked up as-is,
// unlike the EVM keeper's address.toLowerCase() (see server/index.js's
// normalizeAddress, which stores Solana addresses unmodified).
async function loadSubscriberEmail(address) {
  try {
    return await lookupSubscriberEmail(address, CHAIN_NAME);
  } catch (err) {
    console.warn(`Subscriber email lookup failed for ${address}: ${err.message}`);
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

function formatSeconds(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
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

function loadKeypair(p) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  if (!RPC_URL || !PROGRAM_ID || !CONFIG_ADDRESS) {
    throw new Error(
      `Missing SOLANA_${NETWORK_MODE.toUpperCase()}_RPC_URL / _PROGRAM_ID / _CONFIG in .env ` +
        `(see the values printed by scripts/solana-devnet-setup.mjs).`,
    );
  }

  const keeper = loadKeypair(KEEPER_KEYPAIR_PATH);
  const connection = new Connection(RPC_URL, "confirmed");
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "subscription_manager.json")));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keeper), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new anchor.Program(idl, provider);

  const config = new PublicKey(CONFIG_ADDRESS);
  const configAccount = await program.account.config.fetch(config);
  const mint = configAccount.paymentMint;
  const treasuryTokenAccount = configAccount.treasuryTokenAccount;

  console.log(`Keeper running as ${keeper.publicKey.toBase58()} on Solana ${NETWORK_MODE}`);
  console.log(`Watching config ${config.toBase58()} (mint ${mint.toBase58()}). Polling every ${POLL_INTERVAL_MS / 1000}s. Ctrl+C to stop.\n`);

  const fetchSubsByStatus = async (status) =>
    program.account.subscription.all([
      { memcmp: { offset: SUBSCRIPTION_LAYOUT.config, bytes: config.toBase58() } },
      { memcmp: { offset: SUBSCRIPTION_LAYOUT.status, bytes: bs58.encode(Buffer.from([status])) } },
    ]);

  const planPda = (planId) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("plan"), config.toBuffer(), new anchor.BN(planId).toArrayLike(Buffer, "le", 8)],
      program.programId,
    )[0];

  const notifyIfRegistered = async (userPubkey, sub, txHash) => {
    const email = await loadSubscriberEmail(userPubkey.toBase58());
    if (!email) return;
    const plan = await program.account.plan.fetch(planPda(sub.planId.toNumber()));
    await sendReceiptEmail({
      to: email,
      amountLabel: `${(plan.price.toNumber() / 1_000_000).toFixed(2)} tokens`,
      plan: planLabel(plan.interval.toNumber()),
      nextChargeAt: new Date(sub.nextChargeAt.toNumber() * 1000).toLocaleString(),
      txHash,
    });
  };

  const tick = async () => {
    const time = new Date().toLocaleTimeString();
    const now = Math.floor(Date.now() / 1000);

    const active = await fetchSubsByStatus(STATUS_ACTIVE);
    const overdueForLog = await fetchSubsByStatus(STATUS_OVERDUE);
    // Visibility even when nothing needs charging yet — without this, the
    // keeper looks idle/dead for the entire billing period between
    // subscribe and the next actual charge (30 days on a real plan).
    console.log(
      `[${time}] poll: ${active.length} active, ${overdueForLog.length} overdue` +
        (active.length
          ? "\n" +
            active
              .map(({ account: sub }) => {
                const dueIn = sub.nextChargeAt.toNumber() - now;
                const when = dueIn <= 0 ? "due now" : `due in ${formatSeconds(dueIn)} (${new Date(sub.nextChargeAt.toNumber() * 1000).toLocaleString()})`;
                return `    - ${sub.user.toBase58()}: ${when}`;
              })
              .join("\n")
          : ""),
    );

    for (const { account: sub, publicKey: subscriptionPda } of active) {
      if (sub.nextChargeAt.toNumber() > now) continue;
      const user = sub.user;
      try {
        const plan = planPda(sub.planId.toNumber());
        const userTokenAccount = getAssociatedTokenAddressSync(mint, user);
        const sig = await program.methods
          .chargeDue()
          .accounts({
            config,
            user,
            plan,
            subscription: subscriptionPda,
            userTokenAccount,
            treasuryTokenAccount,
            keeperRewardTokenAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        console.log(`[${time}] chargeDue(${user.toBase58()}) OK — ${sig}`);
        const updated = await program.account.subscription.fetch(subscriptionPda);
        // Confirmed empirically (scripts/solana-devnet-smoke.mjs): Anchor's
        // JS client lowercases the enum variant's first letter (`{ active:
        // {} }`), unlike the IDL's own raw-Rust-cased type definition —
        // only send a "renewed" receipt if the charge actually succeeded
        // (Active), not if it fell through to Overdue (insufficient funds).
        if (updated.status.active !== undefined) {
          await notifyIfRegistered(user, updated, sig);
        }
      } catch (err) {
        console.error(`[${time}] chargeDue failed for ${user.toBase58()}:`, err.message);
      }
    }

    const overdue = await fetchSubsByStatus(STATUS_OVERDUE);
    for (const { account: sub, publicKey: subscriptionPda } of overdue) {
      const user = sub.user;
      const plan = planPda(sub.planId.toNumber());
      try {
        const userTokenAccount = getAssociatedTokenAddressSync(mint, user);
        const sig = await program.methods
          .retryCharge()
          .accounts({
            config,
            user,
            plan,
            subscription: subscriptionPda,
            userTokenAccount,
            treasuryTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        console.log(`[${time}] retryCharge(${user.toBase58()}) OK — ${sig}`);
        const updated = await program.account.subscription.fetch(subscriptionPda);
        await notifyIfRegistered(user, updated, sig);
      } catch {
        const planAccount = await program.account.plan.fetch(plan);
        if (now >= sub.overdueSince.toNumber() + planAccount.gracePeriod.toNumber()) {
          try {
            const sig = await program.methods
              .expireOverdue()
              .accounts({ config, user, plan, subscription: subscriptionPda })
              .rpc();
            console.log(`[${time}] expireOverdue(${user.toBase58()}) OK — ${sig}`);
          } catch (err) {
            console.error(`[${time}] expireOverdue failed for ${user.toBase58()}:`, err.message);
          }
        }
      }
    }
  };

  await tick();
  setInterval(() => {
    tick().catch((err) => console.error("Keeper tick failed:", err.message));
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
