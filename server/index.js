require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");

const PORT = process.env.NOTIFY_PORT || 4000;

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
app.use(cors());
app.use(express.json());

// Upserts one subscriber row per (wallet_address, chain_name), called once a
// subscribe() transaction confirms on-chain — plan_id/plan_label/tx_hash
// always reflect the most recent real subscription on that chain. email and
// traffic_source are optional/best-effort and only overwritten when a new
// non-empty value is actually sent, so a later call with no email doesn't
// blank out one captured earlier.
app.post("/api/subscribers", async (req, res) => {
  const { address, chainName, chainId, email, trafficSource, planId, planLabel, txHash } = req.body || {};

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

  try {
    await pool.query(
      `INSERT INTO subscribers
         (wallet_address, chain_name, chain_id, email, traffic_source, plan_id, plan_label, tx_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         chain_id = VALUES(chain_id),
         email = COALESCE(NULLIF(VALUES(email), ''), email),
         traffic_source = COALESCE(NULLIF(VALUES(traffic_source), ''), traffic_source),
         plan_id = VALUES(plan_id),
         plan_label = VALUES(plan_label),
         tx_hash = VALUES(tx_hash)`,
      [
        walletAddress,
        chainName,
        chainId ?? null,
        email || null,
        trafficSource || null,
        planId ?? null,
        planLabel ?? null,
        txHash ?? null,
      ],
    );
    console.log(`Upserted subscriber ${walletAddress} on ${chainName} (plan ${planId ?? "?"}, tx ${txHash ?? "-"})`);
    res.json({ ok: true });
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

app.listen(PORT, () => {
  console.log(`Notification server listening on http://localhost:${PORT}`);
});
