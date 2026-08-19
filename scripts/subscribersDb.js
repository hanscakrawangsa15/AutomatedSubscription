// Shared MySQL `subscribers` table access for the keeper script — needs
// only a read (renewal-email lookup by wallet+chain), never a write; the
// row itself is written once by server/index.js when a subscribe()
// transaction confirms (see docs on that endpoint).
const mysql = require("mysql2/promise");

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return pool;
}

// EVM addresses are stored lowercased (see server/index.js's
// normalizeAddress) — Solana addresses are case-sensitive base58 and are
// stored exactly as given, so callers must pass them through unchanged.
async function lookupSubscriberEmail(walletAddress, chainName) {
  const [rows] = await getPool().query(
    "SELECT email FROM subscribers WHERE wallet_address = ? AND chain_name = ? LIMIT 1",
    [walletAddress, chainName],
  );
  return rows[0]?.email || null;
}

// Called by the keeper after every chargeDue/retryCharge/expireOverdue
// attempt — every field here is read straight off the on-chain
// Subscription struct (or derived from it, see keeper.js), so this always
// reflects the contract's own state rather than a separately-maintained
// value that could drift out of sync with it. A no-op (0 rows affected) if
// the row doesn't exist yet, which is fine — it's only ever expected to
// already exist, written by server/index.js's /api/subscribers on the
// initial subscribe.
async function updateRenewalInfo(walletAddress, chainName, { periodsPaid, nextChargeAtSeconds, status, renewalResult }) {
  await getPool().query(
    `UPDATE subscribers
       SET periods_paid = ?, next_charge_at = FROM_UNIXTIME(?), status = ?, last_renewal_result = ?
     WHERE wallet_address = ? AND chain_name = ?`,
    [periodsPaid, nextChargeAtSeconds, status, renewalResult, walletAddress, chainName],
  );
}

module.exports = { lookupSubscriberEmail, updateRenewalInfo };
