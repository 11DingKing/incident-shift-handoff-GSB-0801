-- 003_supplementary_handoff.sql
-- Support for supplementary (child) handoff packages that only snapshot the
-- changes/new items since a parent package was acknowledged.

-- Link a handoff to its parent package. NULL means a top-level (initial) handoff.
ALTER TABLE handoffs
  ADD COLUMN IF NOT EXISTS parent_handoff_id TEXT REFERENCES handoffs(handoff_id),
  ADD COLUMN IF NOT EXISTS handoff_kind TEXT NOT NULL DEFAULT 'primary';
  -- 'primary' | 'supplementary'

CREATE INDEX IF NOT EXISTS idx_handoffs_parent ON handoffs(parent_handoff_id);

-- Per-field diffs captured by a supplementary handoff.
-- Only NEW action items and CHANGED fields on existing items are recorded here;
-- unchanged items from the parent are intentionally omitted.
CREATE TABLE IF NOT EXISTS handoff_diffs (
  diff_id          TEXT PRIMARY KEY,
  handoff_id       TEXT NOT NULL REFERENCES handoffs(handoff_id) ON DELETE CASCADE,
  ref_id           TEXT NOT NULL,                 -- action_item_id or event_id
  ref_type         TEXT NOT NULL,                 -- 'action_item' | 'timeline_event'
  change_kind      TEXT NOT NULL,                 -- 'added' | 'modified'
  field            TEXT NOT NULL,                 -- e.g. status / owner / title (or '*' for added)
  old_value        TEXT,
  new_value        TEXT,
  item_order       INTEGER NOT NULL DEFAULT 0
);

-- An earlier draft of this migration named the column "diff_kind". If that
-- legacy column exists, backfill its values into change_kind and drop it so the
-- INSERT in the repository does not violate the NOT NULL constraint on the
-- leftover column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='handoff_diffs' AND column_name='diff_kind'
  ) THEN
    EXECUTE 'UPDATE handoff_diffs SET change_kind = diff_kind WHERE change_kind IS DISTINCT FROM diff_kind';
    ALTER TABLE handoff_diffs DROP COLUMN diff_kind;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_handoff_diffs_handoff ON handoff_diffs(handoff_id);

-- Idempotency for supplementary handoff creation. The same idempotency key (by
-- parent + creating shift) must never produce a second package / diff set / audit.
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_handoff_supp_idempotency
  ON handoffs(parent_handoff_id, idempotency_key)
  WHERE parent_handoff_id IS NOT NULL;
