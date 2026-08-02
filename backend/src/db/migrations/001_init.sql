-- 001_init.sql
-- Emergency incident shift handoff schema
-- All tables use stable string IDs, optimistic version numbers (xmin-style integer),
-- and explicit responsible parties + occurrence timestamps.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Incidents (the overarching emergency event, e.g. inc-gd-20260729-01)
CREATE TABLE incidents (
  incident_id      TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  severity         TEXT NOT NULL DEFAULT 'unknown',
  status           TEXT NOT NULL DEFAULT 'active',
  occurred_at      TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  version          INTEGER NOT NULL DEFAULT 1
);

-- Action items attached to an incident. Mutable while no acknowledged handoff freezes a view.
CREATE TABLE action_items (
  action_item_id   TEXT PRIMARY KEY,
  incident_id      TEXT NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'open',  -- open | in_progress | done | blocked
  owner            TEXT NOT NULL,                 -- responsible party
  due_at           TIMESTAMPTZ,
  occurred_at      TIMESTAMPTZ NOT NULL,          -- when the action was raised
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  version          INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT action_items_status_chk CHECK (status IN ('open','in_progress','done','blocked'))
);
CREATE INDEX idx_action_items_incident ON action_items(incident_id);

-- Evidence / timeline events. Append-only log for an incident.
CREATE TABLE timeline_events (
  event_id         TEXT PRIMARY KEY,
  incident_id      TEXT NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
  event_type       TEXT NOT NULL,                 -- e.g. road_closure, evidence_ingested, update
  summary          TEXT NOT NULL,
  actor            TEXT NOT NULL,                 -- who reported / confirmed
  occurred_at      TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  version          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_timeline_incident_time ON timeline_events(incident_id, occurred_at);

-- Handoff packages. Once acknowledged, the snapshot is immutable.
CREATE TABLE handoffs (
  handoff_id       TEXT PRIMARY KEY,
  incident_id      TEXT NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
  from_shift       TEXT NOT NULL,
  to_shift         TEXT NOT NULL,
  summary          TEXT NOT NULL DEFAULT '',
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at  TIMESTAMPTZ,
  acknowledged_by  TEXT,
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | acknowledged
  version          INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT handoffs_status_chk CHECK (status IN ('pending','acknowledged'))
);
CREATE INDEX idx_handoffs_incident ON handoffs(incident_id);

-- Snapshot of action items inside a handoff package (immutable once acknowledged).
CREATE TABLE handoff_items (
  handoff_item_id  TEXT PRIMARY KEY,
  handoff_id       TEXT NOT NULL REFERENCES handoffs(handoff_id) ON DELETE CASCADE,
  action_item_id   TEXT NOT NULL REFERENCES action_items(action_item_id),
  title            TEXT NOT NULL,
  status           TEXT NOT NULL,
  owner            TEXT NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL,
  snapshot_version INTEGER NOT NULL,              -- action item version at snapshot time
  item_order       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_handoff_items_handoff ON handoff_items(handoff_id);

-- Snapshot of timeline events inside a handoff package.
CREATE TABLE handoff_timeline (
  handoff_timeline_id TEXT PRIMARY KEY,
  handoff_id       TEXT NOT NULL REFERENCES handoffs(handoff_id) ON DELETE CASCADE,
  event_id         TEXT NOT NULL REFERENCES timeline_events(event_id),
  event_type       TEXT NOT NULL,
  summary          TEXT NOT NULL,
  actor            TEXT NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL,
  item_order       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_handoff_timeline_handoff ON handoff_timeline(handoff_id);

-- Per-item confirmations (item-by-item acknowledgment). Idempotent by (handoff_id, action_item_id, confirmed_by).
CREATE TABLE handoff_acknowledgments (
  acknowledgment_id TEXT PRIMARY KEY,
  handoff_id        TEXT NOT NULL REFERENCES handoffs(handoff_id) ON DELETE CASCADE,
  action_item_id    TEXT,                          -- nullable: a package-level ack has NULL action_item_id
  confirmed_by      TEXT NOT NULL,
  confirmed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  note              TEXT NOT NULL DEFAULT '',
  idempotency_key   TEXT NOT NULL,
  UNIQUE (handoff_id, action_item_id, confirmed_by)
);
-- PostgreSQL treats NULL as distinct in a unique constraint, so a package-level
-- ack (action_item_id IS NULL) would not be de-duplicated by the constraint above.
-- Add a partial unique index to guarantee at most one package-level ack per (handoff, confirmed_by).
CREATE UNIQUE INDEX uq_ack_package_per_user
  ON handoff_acknowledgments(handoff_id, confirmed_by)
  WHERE action_item_id IS NULL;
CREATE INDEX idx_ack_handoff ON handoff_acknowledgments(handoff_id);

-- Supplementary events appended AFTER a handoff was acknowledged.
-- They are linked back to the original handoff so the incoming shift sees what changed.
CREATE TABLE supplementary_events (
  supplementary_id TEXT PRIMARY KEY,
  incident_id      TEXT NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
  handoff_id       TEXT NOT NULL REFERENCES handoffs(handoff_id),
  change_type      TEXT NOT NULL,                 -- action_item_updated | timeline_added | action_item_added
  ref_id           TEXT NOT NULL,                 -- action_item_id or event_id
  summary          TEXT NOT NULL,
  actor            TEXT NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  version          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_supp_handoff ON supplementary_events(handoff_id);
CREATE INDEX idx_supp_incident ON supplementary_events(incident_id);

-- Append-only audit log for every state-changing operation.
CREATE TABLE audit_events (
  audit_id         TEXT PRIMARY KEY,
  incident_id      TEXT,
  handoff_id       TEXT,
  action           TEXT NOT NULL,
  actor            TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_incident ON audit_events(incident_id, occurred_at);
CREATE INDEX idx_audit_handoff ON audit_events(handoff_id);
