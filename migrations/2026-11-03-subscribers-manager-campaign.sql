-- v2 rollout: one DB row per (wallet, chain, MANAGER) instead of per (wallet, chain),
-- so a v1 subscriber and the same wallet's v2 subscription coexist, and the v1
-- keeper keeps tracking every old (fixed-price) subscription untouched.
-- Also marks partner-campaign (referral) signups.
--
-- BEFORE running: list the chains present and make sure each has a backfill line below:
--   SELECT chain_id, chain_name, COUNT(*) FROM subscribers GROUP BY 1,2;
-- Legacy rows are all v1; their manager is the v1 manager of that chain.
--
-- Run this and then immediately restart notify-server + all keepers with the new
-- code (old code writes rows without manager_address, which the new key can't
-- de-duplicate). Take a backup first: mysqldump automated_subscription subscribers.
--
-- Rollback (only valid while no wallet has both a v1 and a v2 row):
--   ALTER TABLE subscribers DROP INDEX unique_wallet_chain_manager,
--     ADD UNIQUE KEY unique_wallet_chain (wallet_address, chain_name);
--   ALTER TABLE subscribers DROP COLUMN manager_address, DROP COLUMN campaign;

ALTER TABLE subscribers
  ADD COLUMN manager_address VARCHAR(42) NULL AFTER chain_id,
  ADD COLUMN campaign VARCHAR(30) NULL AFTER plan_label;

-- v1 managers: BNB Chain (56) and Ethereum (1).
UPDATE subscribers SET manager_address = '0x34f02a2cf53ad696ae9f8541ae51e37b1cbcf468' WHERE chain_id = 56 AND manager_address IS NULL;
UPDATE subscribers SET manager_address = '0x8011f30979412c9bfe066824fb99284640b25e13' WHERE chain_id = 1 AND manager_address IS NULL;

ALTER TABLE subscribers
  DROP INDEX unique_wallet_chain,
  ADD UNIQUE KEY unique_wallet_chain_manager (wallet_address, chain_name, manager_address);
