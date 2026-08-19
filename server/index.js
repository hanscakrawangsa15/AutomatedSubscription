require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const { sendEmail } = require("../scripts/emailClient");

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
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Solana addresses are base58-encoded ed25519 public keys (32 raw bytes),
// which almost always encode to 43-44 base58 characters.
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// chain_name values are our own slugs (e.g. "base-mainnet", "solana-mainnet"),
// never user input from a URL — validated anyway since it's still request body.
const CHAIN_NAME_RE = /^[a-z0-9-]{1,50}$/;

// Mirrors the contract's Status enum (Inactive/Active/Overdue/Expired),
// lowercased for admin-panel readability — see SubscriptionManager.sol.
const SUBSCRIPTION_STATUSES = ["active", "overdue", "expired", "inactive"];
// Whether the most recent renewal *attempt* actually moved funds
// (chargeDue/retryCharge can succeed as a transaction while still failing
// to charge — see chargeDue's insufficient-allowance/balance branch, which
// marks Overdue instead of reverting).
const RENEWAL_RESULTS = ["success", "failed"];

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
app.use(express.json());
app.use(cookieParser());

// Best-effort confirmation email sent right after a subscribe() transaction
// confirms — mirrors keeper.js's renewal-receipt email but fires
// immediately instead of waiting for the keeper's next poll tick. Never
// awaited by the caller: a slow/failed Resend call must not delay or break
// the subscriber upsert response.
async function sendConfirmationEmail({ to, planLabel, amountLabel, intervalLabel, txHash }) {
  await sendEmail({
    to,
    subject: `Subscription confirmed${amountLabel ? ` — ${amountLabel} charged` : ""}`,
    html: `<p>Your <strong>${planLabel || "subscription"}</strong> is now active.</p>
${amountLabel ? `<p><strong>Amount charged:</strong> ${amountLabel}</p>` : ""}
${intervalLabel ? `<p><strong>Billing interval:</strong> ${intervalLabel}</p>` : ""}
${txHash ? `<p><strong>Transaction:</strong> ${txHash}</p>` : ""}
<p>You'll get another email each time this subscription renews.</p>`,
  });
}

app.post("/api/subscribers", async (req, res) => {
  const {
    address,
    chainName,
    chainId,
    email,
    trafficSource,
    planId,
    planLabel,
    txHash,
    amountLabel,
    intervalLabel,
    periodsPaid,
    nextChargeAt,
    status,
    renewalResult,
  } = req.body || {};

  const walletAddress = normalizeAddress(address);
  if (!walletAddress) {
    return res.status(400).json({ error: "invalid address" });
  }
  if (typeof chainName !== "string" || !CHAIN_NAME_RE.test(chainName)) {
    return res.status(400).json({ error: "invalid chainName" });
  }
  if (email !== undefined && email !== null && email !== "" && (typeof email !== "string" || !EMAIL_RE.test(email))) {
    return res.status(400).json({ error: "invalid email" });
  }
  if (periodsPaid !== undefined && periodsPaid !== null && !Number.isInteger(periodsPaid)) {
    return res.status(400).json({ error: "invalid periodsPaid" });
  }
  if (nextChargeAt !== undefined && nextChargeAt !== null && !Number.isInteger(nextChargeAt)) {
    return res.status(400).json({ error: "invalid nextChargeAt" });
  }
  if (status !== undefined && status !== null && !SUBSCRIPTION_STATUSES.includes(status)) {
    return res.status(400).json({ error: "invalid status" });
  }
  if (renewalResult !== undefined && renewalResult !== null && !RENEWAL_RESULTS.includes(renewalResult)) {
    return res.status(400).json({ error: "invalid renewalResult" });
  }

  try {
    await pool.query(
      `INSERT INTO subscribers
         (wallet_address, chain_name, chain_id, email, traffic_source, plan_id, plan_label, tx_hash, periods_paid, next_charge_at, status, last_renewal_result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?, ?)
       ON DUPLICATE KEY UPDATE
         chain_id = VALUES(chain_id),
         email = COALESCE(NULLIF(VALUES(email), ''), email),
         traffic_source = COALESCE(NULLIF(VALUES(traffic_source), ''), traffic_source),
         plan_id = VALUES(plan_id),
         plan_label = VALUES(plan_label),
         tx_hash = VALUES(tx_hash),
         periods_paid = COALESCE(?, periods_paid),
         next_charge_at = COALESCE(FROM_UNIXTIME(?), next_charge_at),
         status = COALESCE(?, status),
         last_renewal_result = COALESCE(?, last_renewal_result)`,
      [
        walletAddress,
        chainName,
        chainId ?? null,
        email || null,
        trafficSource || null,
        planId ?? null,
        planLabel ?? null,
        txHash ?? null,
        periodsPaid ?? 1,
        nextChargeAt ?? null,
        status ?? "active",
        renewalResult ?? "success",
        periodsPaid ?? null,
        nextChargeAt ?? null,
        status ?? null,
        renewalResult ?? null,
      ],
    );
    console.log(`Upserted subscriber ${walletAddress} on ${chainName} (plan ${planId ?? "?"}, tx ${txHash ?? "-"})`);
    res.json({ ok: true });

    if (email) {
      sendConfirmationEmail({
        to: email,
        planLabel: typeof planLabel === "string" ? planLabel : undefined,
        amountLabel: typeof amountLabel === "string" ? amountLabel : undefined,
        intervalLabel: typeof intervalLabel === "string" ? intervalLabel : undefined,
        txHash: typeof txHash === "string" ? txHash : undefined,
      }).catch((err) => console.error("Confirmation email failed:", err.message));
    }
  } catch (err) {
    console.error("Failed to upsert subscriber:", err.message);
    res.status(500).json({ error: "database error" });
  }
});

app.get("/api/subscribers/:chainName/:address", async (req, res) => {
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

app.post("/api/admin/login", async (req, res) => {
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

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

app.get("/api/admin/subscribers", requireAdmin, async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Number(req.query.pageSize) || PAGE_SIZE_DEFAULT));
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const offset = (page - 1) * pageSize;

  try {
    const where = search ? "WHERE wallet_address LIKE ? OR email LIKE ?" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

    const [rows] = await pool.query(
      `SELECT wallet_address, chain_name, chain_id, email, traffic_source, plan_id, plan_label, tx_hash, periods_paid, next_charge_at, status, last_renewal_result
       FROM subscribers ${where}
       ORDER BY wallet_address, chain_name
       LIMIT ? OFFSET ?`,
      [...searchParams, pageSize, offset],
    );
    const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM subscribers ${where}`, searchParams);

    res.json({ rows, total: countRows[0].total, page, pageSize });
  } catch (err) {
    console.error("Failed to list subscribers:", err.message);
    res.status(500).json({ error: "database error" });
  }
});

app.listen(PORT, () => {
  console.log(`Notification server listening on http://localhost:${PORT}`);
});
