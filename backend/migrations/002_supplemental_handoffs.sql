-- Supplemental handoff packages (GSB-0801, migration 002)
--
-- A supplemental handoff is a *package* (not a free-text note) created after a
-- parent handoff has been signed. It snapshots ONLY what has been added or
-- changed since the parent's frozen sign-off snapshot, and stores that as a
-- structured, field-level diff.
--
-- Invariants encoded here:
--   * Exactly one supplemental package per parent handoff: UNIQUE(parent_handoff_id).
--     Concurrent creates therefore collapse to a single row.
--   * The package is immutable once written (same guard style as handoffs): a
--     trigger rejects UPDATEs so its diff/snapshot can never drift.
--   * It never touches the parent handoff, whose responsible party, status,
--     version and acknowledgements stay exactly as they were at sign-off.

BEGIN;

CREATE TABLE supplemental_handoffs (
  id                TEXT PRIMARY KEY,                       -- stable id, e.g. shp-...
  incident_id       TEXT        NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  parent_handoff_id TEXT        NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
  from_shift        TEXT        NOT NULL,
  to_shift          TEXT        NOT NULL,
  summary           TEXT        NOT NULL DEFAULT '',
  -- Structured diff vs the parent's frozen snapshot: added action items /
  -- timeline events plus per-field changes to items that already existed.
  diff              JSONB       NOT NULL,
  created_by        TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One supplemental package per parent handoff.
CREATE UNIQUE INDEX uq_supplemental_handoff_parent ON supplemental_handoffs(parent_handoff_id);
CREATE INDEX idx_supplemental_handoffs_incident ON supplemental_handoffs(incident_id);

-- Immutability guard: a supplemental package can never be updated after creation.
CREATE OR REPLACE FUNCTION reject_supplemental_handoff_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'supplemental handoff % is immutable', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_supplemental_handoffs_immutable
  BEFORE UPDATE ON supplemental_handoffs
  FOR EACH ROW
  EXECUTE FUNCTION reject_supplemental_handoff_update();

COMMIT;
