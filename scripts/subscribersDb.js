// Shared MySQL `subscribers` table access for the keeper script. Mostly
// reads (renewal-email lookup by wallet+chain, updateRenewalInfo after a
// charge) — the row itself is normally written once by server/index.js's
// /api/subscribers when a subscribe() transaction confirms client-side.
// reconcileMissingSubscriber below is the exception: a real incident
// showed that client-side write can simply never arrive (closed
// wallet/tab right after a successful subscribe(), zero trace on the
// server) — the keeper already scans every Subscribed/Reactivated event
// on-chain for its own discovery purposes, so it double-checks each one
// against the DB and backfills if the row never showed up.
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
      // See the matching comment in server/index.js — mysql2 defaults to
      // interpreting DATETIME values in this process's local timezone
      // rather than the DB server's (UTC), silently shifting every
      // next_charge_at read/write by the difference. "Z" pins both to UTC.
      timezone: "Z",
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
//
// The table keeps ONE row per wallet+chain, but a chain can now have several
// managers (v1 and v2). managerAddress stamps/guards the row: a row that
// already belongs to a different manager is never overwritten by this
// keeper, and a legacy row (manager_address NULL, written before v2) gets
// stamped with this keeper's manager on its next update.
async function updateRenewalInfo(
  walletAddress,
  chainName,
  { managerAddress, periodsPaid, nextChargeAtSeconds, activatedAtSeconds, txHash, status, renewalResult },
) {
  const manager = managerAddress ? managerAddress.toLowerCase() : null;
  await getPool().query(
    `UPDATE subscribers
       SET periods_paid = ?, next_charge_at = FROM_UNIXTIME(?), activated_at = FROM_UNIXTIME(?),
           tx_hash = COALESCE(?, tx_hash), status = ?, last_renewal_result = ?,
           manager_address = COALESCE(manager_address, ?)
     WHERE wallet_address = ? AND chain_name = ?
       AND (manager_address IS NULL OR ? IS NULL OR manager_address = ?)`,
    [periodsPaid, nextChargeAtSeconds, activatedAtSeconds, txHash ?? null, status, renewalResult, manager, walletAddress, chainName, manager, manager],
  );
}

// Backfills a row straight from on-chain data if (and only if) one doesn't
// already exist for this wallet+chain — INSERT IGNORE relies on the
// unique_wallet_chain key (wallet_address, chain_name) to make this a
// no-op rather than an error when the normal client-side write already
// succeeded (the overwhelmingly common case). email/traffic_source are
// never recoverable this way (never submitted anywhere retrievable) — the
// wallet just won't get renewal emails until it resubscribes or shares an
// email some other way.
async function reconcileMissingSubscriber(
  walletAddress,
  chainName,
  { chainId, managerAddress, campaign, planId, planLabel, txHash, periodsPaid, nextChargeAtSeconds, activatedAtSeconds, status, renewalResult },
) {
  const [result] = await getPool().query(
    `INSERT IGNORE INTO subscribers
       (wallet_address, chain_name, chain_id, manager_address, campaign, plan_id, plan_label, tx_hash, periods_paid, next_charge_at, activated_at, status, last_renewal_result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), ?, ?)`,
    [
      walletAddress,
      chainName,
      chainId,
      managerAddress ? managerAddress.toLowerCase() : null,
      campaign || null,
      planId,
      planLabel,
      txHash,
      periodsPaid,
      nextChargeAtSeconds,
      activatedAtSeconds,
      status,
      renewalResult,
    ],
  );
  return result.affectedRows > 0;
}

module.exports = { lookupSubscriberEmail, updateRenewalInfo, reconcileMissingSubscriber };
