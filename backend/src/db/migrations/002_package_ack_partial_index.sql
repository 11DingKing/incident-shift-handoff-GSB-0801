-- 002_package_ack_partial_index.sql
-- Ensure the partial unique index that prevents duplicate package-level
-- acknowledgments exists. Earlier deployments of 001_init.sql predate this
-- index, so we add it here idempotently.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ack_package_per_user
  ON handoff_acknowledgments(handoff_id, confirmed_by)
  WHERE action_item_id IS NULL;
