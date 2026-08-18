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

module.exports = { lookupSubscriberEmail };
