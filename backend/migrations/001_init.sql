-- Emergency incident shift-handoff schema (GSB-0801)
-- Design goals encoded here:
--   * Stable, human-meaningful primary keys for incidents and handoffs.
--   * Optimistic concurrency via integer `version` columns on the mutable aggregates
--     (incidents, action_items, handoffs).
--   * A signed handoff is immutable: `signed_off_at IS NOT NULL` rows are guarded by a
--     trigger that rejects UPDATEs, so the snapshot/timeline/acks captured at sign-off
--     time can never drift.
--   * Post-sign-off change is modelled as append-only `supplemental_events` that must
--     reference the original handoff they amend.
--   * Idempotency keys make retried acknowledgements / sign-offs / appends safe.

BEGIN;

-- ---------------------------------------------------------------------------
-- Incidents
-- ---------------------------------------------------------------------------
CREATE TABLE incidents (
  id            TEXT PRIMARY KEY,                       -- e.g. inc-gd-20260729-01
  title         TEXT        NOT NULL,
  severity      TEXT        NOT NULL DEFAULT 'high',
  status        TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'monitoring', 'closed')),
  responsible_party TEXT    NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  version       INTEGER     NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Action items (things a shift must do / hand off)
-- ---------------------------------------------------------------------------
CREATE TABLE action_items (
  id            TEXT PRIMARY KEY,                       -- stable id, e.g. act-...
  incident_id   TEXT        NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  title         TEXT        NOT NULL,
  detail        TEXT        NOT NULL DEFAULT '',
  status        TEXT        NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'in_progress', 'blocked', 'done')),
  responsible_party TEXT    NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,                   -- when the item was raised
  version       INTEGER     NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_action_items_incident ON action_items(incident_id);

-- ---------------------------------------------------------------------------
-- Timeline / evidence events (append-only within an incident)
-- ---------------------------------------------------------------------------
CREATE TABLE timeline_events (
  id            TEXT PRIMARY KEY,                       -- stable id, e.g. tl-...
  incident_id   TEXT        NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  kind          TEXT        NOT NULL,                   -- road_closure, evidence_intake, ...
  description   TEXT        NOT NULL,
  responsible_party TEXT    NOT NULL,
  evidence_uri  TEXT,                                   -- pointer to stored evidence, nullable
  occurred_at   TIMESTAMPTZ NOT NULL,                   -- when the event actually happened
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),     -- when the evidence landed in the system
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_timeline_incident ON timeline_events(incident_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Handoffs (shift-to-shift transfer packages)
-- ---------------------------------------------------------------------------
CREATE TABLE handoffs (
  id            TEXT PRIMARY KEY,                       -- stable handoff_id, e.g. ho-...
  incident_id   TEXT        NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  from_shift    TEXT        NOT NULL,
  to_shift      TEXT        NOT NULL,
  summary       TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'signed')),
  -- Frozen snapshot of the incident, action items and timeline captured atomically
  -- at sign-off time. Null while the handoff is still a draft.
  snapshot      JSONB,
  created_by    TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_off_by TEXT,
  signed_off_at TIMESTAMPTZ,
  version       INTEGER     NOT NULL DEFAULT 1
);
CREATE INDEX idx_handoffs_incident ON handoffs(incident_id);

-- ---------------------------------------------------------------------------
-- Per-item acknowledgements (the incoming shift confirming each item)
-- A given (handoff, item) can only be acknowledged once thanks to the unique index;
-- retries reuse the idempotency key and never create a second confirmation.
-- ---------------------------------------------------------------------------
CREATE TABLE acknowledgements (
  id              TEXT PRIMARY KEY,                     -- stable id, e.g. ack-...
  handoff_id      TEXT        NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
  item_type       TEXT        NOT NULL CHECK (item_type IN ('action_item', 'timeline_event')),
  item_id         TEXT        NOT NULL,
  acknowledged_by TEXT        NOT NULL,
  note            TEXT        NOT NULL DEFAULT '',
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_ack_handoff_item ON acknowledgements(handoff_id, item_type, item_id);

-- ---------------------------------------------------------------------------
-- Supplemental events: the only legal way to record change *after* a handoff is
-- signed. Every row must point back at the handoff it amends.
-- ---------------------------------------------------------------------------
CREATE TABLE supplemental_events (
  id                  TEXT PRIMARY KEY,                 -- stable id, e.g. sup-...
  incident_id         TEXT        NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  parent_handoff_id   TEXT        NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
  kind                TEXT        NOT NULL,
  description         TEXT        NOT NULL,
  responsible_party   TEXT        NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_supplemental_parent ON supplemental_events(parent_handoff_id);

-- ---------------------------------------------------------------------------
-- Audit log: every meaningful state transition, produced inside the same
-- transaction as the change it describes.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id   TEXT,
  handoff_id    TEXT,
  event_type    TEXT        NOT NULL,
  actor         TEXT        NOT NULL,
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Idempotency keys: retried/duplicated mutations map to the same stored result.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY,
  scope         TEXT        NOT NULL,                   -- e.g. 'acknowledge', 'sign_off'
  response      JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Immutability guard: once a handoff is signed it can never be updated again.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_signed_handoff_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'signed' THEN
    RAISE EXCEPTION 'handoff % is signed and immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_handoffs_immutable
  BEFORE UPDATE ON handoffs
  FOR EACH ROW
  EXECUTE FUNCTION reject_signed_handoff_update();

COMMIT;
