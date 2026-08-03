-- 005_action_item_revisions.sql
-- 行动项版本历史，用于乐观锁的字段级冲突判定（旧版本提交时返回具体冲突字段）。

CREATE TABLE IF NOT EXISTS action_item_revisions (
  action_item_id    text NOT NULL REFERENCES action_items(id) ON DELETE CASCADE,
  version           integer NOT NULL,
  title             text NOT NULL,
  detail            text NOT NULL,
  status            text NOT NULL,
  responsible_party text NOT NULL,
  occurred_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action_item_id, version),
  CONSTRAINT action_item_revisions_status_check
    CHECK (status IN ('open', 'in_progress', 'blocked', 'done'))
);

-- 回填当前版本状态（若已存在数据）。
INSERT INTO action_item_revisions
  (action_item_id, version, title, detail, status, responsible_party, occurred_at)
SELECT id, version, title, detail, status, responsible_party, occurred_at
FROM action_items
ON CONFLICT (action_item_id, version) DO NOTHING;
