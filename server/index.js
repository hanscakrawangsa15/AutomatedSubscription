require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const { sendEmail } = require("../scripts/emailClient");
const { verifySubscriptionTx, VerificationError } = require("./verifyTx");

const PORT = process.env.NOTIFY_PORT || 4000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  // The DB server's own system timezone is UTC (confirmed: NOW() ==
  // UTC_TIMESTAMP() there), but mysql2 defaults to "local" — meaning it
  // interprets DATETIME values using *this process's* timezone instead.
  // Wherever this runs in a non-UTC zone (confirmed: Asia/Jakarta, UTC+7,
  // on this box), every DATETIME read/write silently drifted by that
  // offset — e.g. next_charge_at read back exactly 7 hours earlier than
  // the real on-chain value. "Z" pins both directions to UTC, matching
  // the server's actual storage.
  timezone: "Z",
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Solana addresses are base58-encoded ed25519 public keys (32 raw bytes),
// which almost always encode to 43-44 base58 characters.
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// chain_name values are our own slugs (e.g. "base-mainnet", "solana-mainnet"),
// never user input from a URL — validated anyway since it's still request body.
const CHAIN_NAME_RE = /^[a-z0-9-]{1,50}$/;

// Must match frontend/src/lib/chains.ts's chain_name slugs and keeper.js's
// CHAIN_NAMES — the subscribers table is keyed by this slug.
const CHAIN_NAMES = { 8453: "base-mainnet", 1: "ethereum-mainnet", 56: "bnb-mainnet" };

function chainNameFor(chainId) {
  return CHAIN_NAMES[chainId] || `evm-${chainId}`;
}

// Returns the canonical storage key for a wallet address, or null if the
// address matches no known chain's format. EVM addresses are
// case-insensitive so we normalize to lowercase; Solana addresses are
// case-sensitive base58 and are stored exactly as given.
function normalizeAddress(address) {
  if (typeof address !== "string") return null;
  if (EVM_ADDRESS_RE.test(address)) return address.toLowerCase();
  if (SOLANA_ADDRESS_RE.test(address)) return address;
  return null;
}

const app = express();
// credentials:true + an explicit origin (never "*") is required for the
// admin login cookie to actually be sent back on subsequent requests —
// ADMIN_PANEL_ORIGIN should be the exact origin the admin panel is served
// from (e.g. https://cpay.xenorize.com), comma-separated if there's more
// than one (e.g. a local dev origin alongside production).
const allowedOrigins = (process.env.ADMIN_PANEL_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: "20kb" }));
app.use(cookieParser());

// Minimal in-memory fixed-window rate limiter (per client IP). Good enough for
// a single-process server; behind a proxy, set TRUST_PROXY=1 so req.ip is the
// real client rather than the proxy. Swap for express-rate-limit + a shared
// store if this is ever run as multiple instances.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);

function rateLimit({ windowMs, max, keyOf = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs).unref();
  // Counts one hit for `key`; returns 0 if allowed, else seconds until the
  // window resets.
  const consume = (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return 0;
    }
    if (++entry.count > max) return Math.ceil((entry.resetAt - now) / 1000);
    return 0;
  };
  const middleware = (req, res, next) => {
    const retryAfter = consume(keyOf(req));
    if (!retryAfter) return next();
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "too many requests — try again later" });
  };
  middleware.consume = consume;
  return middleware;
}

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

// Every accepted POST /api/subscribers costs paid RPC calls (receipt + state
// read + block), so it's capped hard: by default a client may make at most 3
// per 10 minutes, counted both per IP and per wallet address (rotating IPs
// doesn't get around the wallet cap, and one shared office/VPN IP doesn't
// starve other wallets of theirs). A real user needs ~1 call per action
// (subscribe / cancel / payNow). Tune via NOTIFY_RPC_MAX_REQUESTS and
// NOTIFY_RPC_WINDOW_MINUTES.
const RPC_MAX_REQUESTS = Number(process.env.NOTIFY_RPC_MAX_REQUESTS) || 3;
const RPC_WINDOW_MS = (Number(process.env.NOTIFY_RPC_WINDOW_MINUTES) || 10) * 60 * 1000;
const subscribeLimiter = rateLimit({ windowMs: RPC_WINDOW_MS, max: RPC_MAX_REQUESTS });
const subscribeWalletLimiter = rateLimit({ windowMs: RPC_WINDOW_MS, max: RPC_MAX_REQUESTS });

// Best-effort confirmation email sent right after a subscribe() transaction
// confirms — mirrors keeper.js's renewal-receipt email but fires
// immediately instead of waiting for the keeper's next poll tick. Never
// awaited by the caller: a slow/failed Resend call must not delay or break
// the subscriber upsert response.
// These fields come straight from the request body, so they're escaped before
// being interpolated into the HTML (and capped in length) — otherwise anyone
// could inject markup/links into an email sent from our own sender domain.
function escapeHtml(value) {
  return String(value)
    .slice(0, 200)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendConfirmationEmail({ to, planLabel, amountLabel, intervalLabel, txHash }) {
  const plan = escapeHtml(planLabel || "subscription");
  const amount = amountLabel ? escapeHtml(amountLabel) : "";
  const interval = intervalLabel ? escapeHtml(intervalLabel) : "";
  const tx = txHash ? escapeHtml(txHash) : "";
  await sendEmail({
    to,
    subject: `Subscription confirmed${amount ? ` — ${amount} charged` : ""}`,
    html: `<p>Your <strong>${plan}</strong> is now active.</p>
${amount ? `<p><strong>Amount charged:</strong> ${amount}</p>` : ""}
${interval ? `<p><strong>Billing interval:</strong> ${interval}</p>` : ""}
${tx ? `<p><strong>Transaction:</strong> ${tx}</p>` : ""}
<p>You'll get another email each time this subscription renews.</p>`,
  });
}

// A confirmation email / email change is only honoured for a transaction this
// recent. Anyone can read a past txHash off the chain, so without a window
// they could replay a victim's old subscribe tx with their own email.
const FRESH_TX_SECONDS = 10 * 60;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

app.post("/api/subscribers", subscribeLimiter, async (req, res) => {
  // Only identity + free-form display fields come from the body. Status,
  // plan, periods and schedule are read from the chain (see verifyTx.js), so
  // nobody can write arbitrary subscription data for a wallet.
  const { address, chainId, txHash, email, trafficSource, planLabel, amountLabel, intervalLabel } = req.body || {};

  const walletAddress = typeof address === "string" && EVM_ADDRESS_RE.test(address) ? address.toLowerCase() : null;
  if (!walletAddress) {
    return res.status(400).json({ error: "invalid address" });
  }
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return res.status(400).json({ error: "invalid chainId" });
  }
  if (typeof txHash !== "string" || !TX_HASH_RE.test(txHash)) {
    return res.status(400).json({ error: "invalid txHash" });
  }
  if (email !== undefined && email !== null && email !== "" && (typeof email !== "string" || !EMAIL_RE.test(email))) {
    return res.status(400).json({ error: "invalid email" });
  }
  for (const [name, value] of Object.entries({ trafficSource, planLabel, amountLabel, intervalLabel })) {
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 200)) {
      return res.status(400).json({ error: `invalid ${name}` });
    }
  }

  const walletRetryAfter = subscribeWalletLimiter.consume(walletAddress);
  if (walletRetryAfter) {
    res.set("Retry-After", String(walletRetryAfter));
    return res.status(429).json({ error: "too many requests for this wallet — try again later" });
  }

  const chainName = chainNameFor(chainId);

  let existing;
  try {
    const [existingRows] = await pool.query(
      "SELECT email, tx_hash FROM subscribers WHERE wallet_address = ? AND chain_name = ? LIMIT 1",
      [walletAddress, chainName],
    );
    existing = existingRows[0];
  } catch (err) {
    console.error("Failed to look up subscriber:", err.message);
    return res.status(500).json({ error: "database error" });
  }
  // This exact tx is already recorded — nothing new to learn from the chain,
  // so skip the RPC calls entirely (a retried/duplicated report costs nothing).
  if (existing?.tx_hash === txHash) {
    return res.json({ ok: true, alreadyRecorded: true });
  }

  let chain;
  try {
    chain = await verifySubscriptionTx({ chainId, txHash, address });
  } catch (err) {
    if (err instanceof VerificationError) return res.status(err.httpStatus).json({ error: err.message });
    console.error("Transaction verification failed:", err.message);
    return res.status(502).json({ error: "could not verify transaction" });
  }

  const fresh = Math.floor(Date.now() / 1000) - chain.blockTimestamp <= FRESH_TX_SECONDS;

  try {
    // An existing email is only replaced by a fresh subscribe tx; otherwise
    // the stored one is kept (null => COALESCE keeps the column as-is).
    const canSetEmail = email && (!existing?.email || (fresh && chain.subscribed));
    const emailToStore = canSetEmail ? email : null;

    await pool.query(
      `INSERT INTO subscribers
         (wallet_address, chain_name, chain_id, manager_address, campaign, email, traffic_source, plan_id, plan_label, tx_hash, periods_paid, next_charge_at, activated_at, status, last_renewal_result)
       VALUES (?, ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), ?, ?)
       ON DUPLICATE KEY UPDATE
         chain_id = VALUES(chain_id),
         manager_address = VALUES(manager_address),
         campaign = IF(? IS NULL, campaign, VALUES(campaign)),
         email = COALESCE(NULLIF(VALUES(email), ''), email),
         traffic_source = COALESCE(NULLIF(VALUES(traffic_source), ''), traffic_source),
         plan_id = VALUES(plan_id),
         plan_label = COALESCE(VALUES(plan_label), plan_label),
         tx_hash = VALUES(tx_hash),
         periods_paid = VALUES(periods_paid),
         next_charge_at = VALUES(next_charge_at),
         activated_at = COALESCE(VALUES(activated_at), activated_at),
         status = VALUES(status),
         last_renewal_result = COALESCE(VALUES(last_renewal_result), last_renewal_result)`,
      [
        walletAddress,
        chainName,
        chainId,
        chain.managerAddress,
        chain.campaign,
        emailToStore,
        trafficSource || null,
        chain.planId,
        planLabel ?? null,
        txHash,
        chain.periodsPaid,
        chain.nextChargeAt,
        chain.activatedAt,
        chain.status,
        chain.charged || !existing ? "success" : null,
        chain.campaign,
      ],
    );
    console.log(`Upserted subscriber ${walletAddress} on ${chainName} (plan ${chain.planId}, tx ${txHash})`);
    res.json({ ok: true });

    // Only for a fresh subscribe; a replay of an already-recorded tx returned
    // early above, so it can't re-trigger the email.
    if (emailToStore && fresh && chain.subscribed) {
      sendConfirmationEmail({
        to: emailToStore,
        planLabel: planLabel ?? undefined,
        amountLabel: amountLabel ?? undefined,
        intervalLabel: intervalLabel ?? undefined,
        txHash,
      }).catch((err) => console.error("Confirmation email failed:", err.message));
    }
  } catch (err) {
    console.error("Failed to upsert subscriber:", err.message);
    res.status(500).json({ error: "database error" });
  }
});

// Fast-path subscription lookup by wallet alone (no chainName needed) — the
// frontend calls this right after a wallet connects so it can render
// Manage Subscription immediately from our own DB instead of waiting on
// live on-chain reads across every configured payment method/chain. This
// is a display optimization only: the frontend still re-verifies against
// the chain in the background and corrects the UI if the DB has drifted
// (e.g. a sync write that failed at the time), so a stale/missing row here
// never causes incorrect access — only a slower first paint.
//
// Registered *before* the /:chainName/:address route below — Express
// matches routes in registration order, and "by-wallet" would otherwise be
// captured as :chainName by that more generic pattern first.
app.get("/api/subscribers/by-wallet/:address", async (req, res) => {
  const walletAddress = normalizeAddress(req.params.address);
  if (!walletAddress) {
    return res.status(400).json({ error: "invalid address" });
  }
  try {
    const [rows] = await pool.query(
      `SELECT chain_name, chain_id, manager_address, campaign, plan_id, plan_label, periods_paid, next_charge_at, status, tx_hash
       FROM subscribers
       WHERE wallet_address = ?`,
      [walletAddress],
    );
    res.json({ rows });
  } catch (err) {
    console.error("Failed to look up subscriber by wallet:", err.message);
    res.status(500).json({ error: "database error" });
  }
});

// Returns a subscriber's email, so it's admin-only: left public it would let
// anyone map any wallet address to its owner's email. Neither the frontend
// nor the keeper calls this (the keeper reads the DB directly).
app.get("/api/subscribers/:chainName/:address", requireAdmin, async (req, res) => {
  const walletAddress = normalizeAddress(req.params.address);
  const { chainName } = req.params;
  if (!walletAddress || !CHAIN_NAME_RE.test(chainName)) {
    return res.status(400).json({ error: "invalid address or chainName" });
  }
  try {
    const [rows] = await pool.query(
      "SELECT email FROM subscribers WHERE wallet_address = ? AND chain_name = ? LIMIT 1",
      [walletAddress, chainName],
    );
    res.json({ email: rows[0]?.email || null });
  } catch (err) {
    console.error("Failed to look up subscriber:", err.message);
    res.status(500).json({ error: "database error" });
  }
});

// --- Admin panel: login-gated read access to the subscribers table ---
// ADMIN_USERNAME / ADMIN_PASSWORD_HASH / ADMIN_JWT_SECRET are set in .env —
// see scripts/hash-admin-password.js for generating the password hash
// without ever having to share the plaintext password with anyone else.
const ADMIN_COOKIE = "admin_token";
const ADMIN_SESSION_MINUTES = 30;

function requireAdminEnv(res) {
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD_HASH || !process.env.ADMIN_JWT_SECRET) {
    res.status(503).json({ error: "Admin panel isn't configured — see scripts/hash-admin-password.js" });
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (!token) return res.status(401).json({ error: "not logged in" });
  try {
    jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "session expired — log in again" });
  }
}

app.post("/api/admin/login", loginLimiter, async (req, res) => {
  if (!requireAdminEnv(res)) return;
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "username and password are required" });
  }

  // Constant-time-ish: always run bcrypt.compare even on a username
  // mismatch, so a wrong username doesn't return measurably faster than a
  // wrong password (avoids leaking which one was wrong via timing).
  const usernameOk = username === process.env.ADMIN_USERNAME;
  const passwordOk = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH).catch(() => false);
  if (!usernameOk || !passwordOk) {
    return res.status(401).json({ error: "invalid username or password" });
  }

  const token = jwt.sign({ sub: username, role: "admin" }, process.env.ADMIN_JWT_SECRET, {
    expiresIn: `${ADMIN_SESSION_MINUTES}m`,
  });
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: IS_PRODUCTION ? "none" : "lax",
    maxAge: ADMIN_SESSION_MINUTES * 60 * 1000,
  });
  res.json({ ok: true, username });
});

app.post("/api/admin/logout", (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.json({ ok: true });
});

app.get("/api/admin/me", (req, res) => {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (!token || !process.env.ADMIN_JWT_SECRET) return res.status(401).json({ error: "not logged in" });
  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    res.json({ ok: true, username: payload.sub });
  } catch {
    res.status(401).json({ error: "session expired" });
  }
});

// Managers deployed with the v2 contract (lead-time billing + promo plans) are
// the ones configured under an env suffix ending in _V2
// (SUBSCRIPTION_MANAGER_ADDRESS_<chainId>[_TOKEN]_V2).
function v2ManagerAddresses() {
  const out = new Set();
  for (const [key, value] of Object.entries(process.env)) {
    if (/^SUBSCRIPTION_MANAGER_ADDRESS_\d+(?:_[A-Z0-9]+)*_V2$/.test(key) && value) out.add(value.toLowerCase());
  }
  return out;
}

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

// Column names can't go through a `?` placeholder (mysql2 would quote them
// as a string literal, not an identifier) — allowlisting the exact set the
// admin table can sort by is what keeps req.query.sortBy safe to interpolate
// directly into the ORDER BY clause below.
const SORTABLE_COLUMNS = new Set([
  "wallet_address",
  "chain_name",
  "email",
  "plan_label",
  "campaign",
  "status",
  "periods_paid",
  "last_renewal_result",
  "activated_at",
  "next_charge_at",
  "traffic_source",
]);

app.get("/api/admin/subscribers", requireAdmin, async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Number(req.query.pageSize) || PAGE_SIZE_DEFAULT));
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const offset = (page - 1) * pageSize;
  const sortBy = SORTABLE_COLUMNS.has(req.query.sortBy) ? req.query.sortBy : "wallet_address";
  const sortDir = req.query.sortDir === "desc" ? "DESC" : "ASC";

  try {
    const where = search ? "WHERE wallet_address LIKE ? OR email LIKE ?" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

    // NULLs (e.g. a wallet with no email, or a row not yet renewed) always
    // sort last regardless of direction — otherwise DESC would put every
    // NULL first, which reads as "empty rows on top" rather than useful
    // sorting.
    const [rows] = await pool.query(
      `SELECT wallet_address, chain_name, chain_id, manager_address, campaign, email, traffic_source, plan_id, plan_label, tx_hash, periods_paid, next_charge_at, activated_at, status, last_renewal_result
       FROM subscribers ${where}
       ORDER BY ${sortBy} IS NULL, ${sortBy} ${sortDir}, wallet_address, chain_name
       LIMIT ? OFFSET ?`,
      [...searchParams, pageSize, offset],
    );
    const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM subscribers ${where}`, searchParams);

    // plan_id alone is ambiguous now that v1 and v2 managers both exist on a
    // chain (each numbers its plans from #0), so label which generation a row
    // belongs to. Rows written before manager_address existed are all v1.
    const v2 = v2ManagerAddresses();
    const withVersion = rows.map((r) => ({
      ...r,
      contract_version: r.manager_address && v2.has(r.manager_address.toLowerCase()) ? "v2" : "v1",
    }));

    res.json({ rows: withVersion, total: countRows[0].total, page, pageSize });
  } catch (err) {
    console.error("Failed to list subscribers:", err.message);
    res.status(500).json({ error: "database error" });
  }
});

app.listen(PORT, () => {
  console.log(`Notification server listening on http://localhost:${PORT}`);
});
