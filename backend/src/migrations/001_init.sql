-- 001_init.sql
-- 应急事件交接系统初始 schema：事件、行动项、证据时间线、交接包、逐项确认、审计、幂等键。

CREATE TABLE IF NOT EXISTS incidents (
  id                text PRIMARY KEY,
  title             text NOT NULL,
  severity          text NOT NULL DEFAULT 'high',
  status            text NOT NULL DEFAULT 'active',
  responsible_party text NOT NULL,
  occurred_at       timestamptz NOT NULL,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incidents_status_check
    CHECK (status IN ('active', 'monitoring', 'closed'))
);

CREATE TABLE IF NOT EXISTS action_items (
  id                text PRIMARY KEY,
  incident_id       text NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  title             text NOT NULL,
  detail            text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'open',
  responsible_party text NOT NULL,
  occurred_at       timestamptz NOT NULL,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT action_items_status_check
    CHECK (status IN ('open', 'in_progress', 'blocked', 'done'))
);
CREATE INDEX IF NOT EXISTS idx_action_items_incident ON action_items(incident_id);

CREATE TABLE IF NOT EXISTS timeline_events (
  id                text PRIMARY KEY,
  incident_id       text NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  kind              text NOT NULL,
  description       text NOT NULL,
  responsible_party text NOT NULL,
  evidence_uri      text,
  occurred_at       timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_timeline_incident
  ON timeline_events(incident_id, occurred_at);

CREATE TABLE IF NOT EXISTS handoffs (
  id            text PRIMARY KEY,
  incident_id   text NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  from_shift    text NOT NULL,
  to_shift      text NOT NULL,
  summary       text NOT NULL,
  status        text NOT NULL DEFAULT 'draft',
  snapshot      jsonb,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  signed_off_by text,
  signed_off_at timestamptz,
  version       integer NOT NULL DEFAULT 1,
  CONSTRAINT handoffs_status_check CHECK (status IN ('draft', 'signed'))
);
CREATE INDEX IF NOT EXISTS idx_handoffs_incident ON handoffs(incident_id);

CREATE TABLE IF NOT EXISTS acknowledgements (
  id              text PRIMARY KEY,
  handoff_id      text NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
  item_type       text NOT NULL,
  item_id         text NOT NULL,
  acknowledged_by text NOT NULL,
  note            text NOT NULL DEFAULT '',
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acknowledgements_item_type_check
    CHECK (item_type IN ('action_item', 'timeline_event'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ack_handoff_item
  ON acknowledgements(handoff_id, item_type, item_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id text,
  handoff_id  text,
  event_type  text NOT NULL,
  actor       text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        text PRIMARY KEY,
  scope      text NOT NULL,
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 已签收交接包不可修改（触发器在 002 之前即就位，保护 handoffs）。
CREATE OR REPLACE FUNCTION reject_signed_handoff_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'signed' THEN
    RAISE EXCEPTION 'handoff % is signed and immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_handoffs_immutable ON handoffs;
CREATE TRIGGER trg_handoffs_immutable
  BEFORE UPDATE ON handoffs
  FOR EACH ROW
  EXECUTE FUNCTION reject_signed_handoff_update();
