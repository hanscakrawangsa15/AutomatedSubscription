-- v2 rollout: tell v1 and v2 managers apart and mark partner-campaign signups.
-- Additive + nullable: the currently deployed server/keeper keep working with
-- these columns present (they just don't fill them), so run this BEFORE
-- deploying the new server/keeper code. Existing rows stay NULL = legacy v1.
--
-- Rollback: ALTER TABLE subscribers DROP COLUMN manager_address, DROP COLUMN campaign;
ALTER TABLE subscribers
  ADD COLUMN manager_address VARCHAR(42) NULL AFTER chain_id,
  ADD COLUMN campaign VARCHAR(30) NULL AFTER plan_label;
