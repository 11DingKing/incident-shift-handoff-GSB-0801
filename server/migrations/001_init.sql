-- 001_init.sql — schema for incident shift handoff system
BEGIN;

CREATE TABLE incidents (
  id         text PRIMARY KEY,
  title      text NOT NULL,
  status     text NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'monitoring', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 行动项：锁定 incident_id / 状态枚举 / 乐观版本号
CREATE TABLE action_items (
  id          text PRIMARY KEY,
  incident_id text NOT NULL REFERENCES incidents (id),
  title       text NOT NULL,
  owner       text NOT NULL,              -- 责任方
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'in_progress', 'done', 'verified')),
  version     integer NOT NULL DEFAULT 1, -- 乐观版本号
  occurred_at timestamptz NOT NULL,       -- 发生时间（提出时间）
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 交接包：已签收不可修改（应用层强制 + status 流转单向）
CREATE TABLE handoffs (
  id          text PRIMARY KEY,
  incident_id text NOT NULL REFERENCES incidents (id),
  from_shift  text NOT NULL,
  to_shift    text NOT NULL,
  note        text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'signed')),
  version     integer NOT NULL DEFAULT 1,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  signed_at   timestamptz
);

-- 签收时刻的逐项快照 + 逐项确认记录（确认不改动 action_items.status）
CREATE TABLE handoff_items (
  handoff_id      text NOT NULL REFERENCES handoffs (id),
  action_item_id  text NOT NULL REFERENCES action_items (id),
  title           text NOT NULL,   -- 快照
  owner           text NOT NULL,   -- 快照
  status_at_sign  text NOT NULL,   -- 快照
  version_at_sign integer NOT NULL,-- 快照
  confirmed       boolean NOT NULL DEFAULT false,
  confirmed_by    text,
  confirmed_at    timestamptz,
  PRIMARY KEY (handoff_id, action_item_id)
);

-- 时间线：evidence（证据）/ supplement（签收后追加，关联原交接包）/ audit（审计）
CREATE TABLE timeline_events (
  id          text PRIMARY KEY,
  incident_id text NOT NULL REFERENCES incidents (id),
  handoff_id  text REFERENCES handoffs (id), -- 补充/审计事件关联的交接包
  kind        text NOT NULL CHECK (kind IN ('evidence', 'supplement', 'audit')),
  title       text NOT NULL,
  detail      text NOT NULL DEFAULT '',
  owner       text NOT NULL,                 -- 责任方/报告方
  occurred_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_timeline_incident ON timeline_events (incident_id, occurred_at);
CREATE INDEX idx_timeline_handoff  ON timeline_events (handoff_id);
CREATE INDEX idx_items_incident    ON action_items (incident_id);
CREATE INDEX idx_handoffs_incident ON handoffs (incident_id);

-- 幂等键：断线重试 / 重复提交直接重放首次响应
CREATE TABLE idempotency_keys (
  key         text PRIMARY KEY,
  method      text NOT NULL,
  path        text NOT NULL,
  status_code integer,              -- NULL 表示处理中（占位认领）
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMIT;
