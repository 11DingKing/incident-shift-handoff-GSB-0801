-- 002_supplemental_handoffs.sql
-- 签收之后发生的变化：追加为补充事件，并以唯一的补充交接包承载差异视图。

CREATE TABLE IF NOT EXISTS supplemental_events (
  id                text PRIMARY KEY,
  incident_id       text NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  parent_handoff_id text NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
  kind              text NOT NULL,
  description       text NOT NULL,
  responsible_party text NOT NULL,
  occurred_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplemental_parent
  ON supplemental_events(parent_handoff_id);

CREATE TABLE IF NOT EXISTS supplemental_handoffs (
  id                text PRIMARY KEY,
  incident_id       text NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  parent_handoff_id text NOT NULL UNIQUE REFERENCES handoffs(id) ON DELETE CASCADE,
  from_shift        text NOT NULL,
  to_shift          text NOT NULL,
  summary           text NOT NULL DEFAULT '',
  diff              jsonb NOT NULL,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplemental_handoffs_incident
  ON supplemental_handoffs(incident_id);

-- 补充交接包同样不可修改。
CREATE OR REPLACE FUNCTION reject_supplemental_handoff_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'supplemental handoff % is immutable', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_supplemental_handoffs_immutable ON supplemental_handoffs;
CREATE TRIGGER trg_supplemental_handoffs_immutable
  BEFORE UPDATE ON supplemental_handoffs
  FOR EACH ROW
  EXECUTE FUNCTION reject_supplemental_handoff_update();
