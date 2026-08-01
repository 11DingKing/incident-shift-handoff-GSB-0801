-- 003_ack_scope_version.sql
-- 逐项确认支持补充交接包作用域，并记录确认时的行动项版本号。

ALTER TABLE acknowledgements
  ADD COLUMN IF NOT EXISTS supplemental_handoff_id text
    REFERENCES supplemental_handoffs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS acked_version integer;

-- 旧的唯一约束只覆盖 handoff+item；补充交接包需要按 (handoff, supplemental, item) 去重。
DROP INDEX IF EXISTS uq_ack_handoff_item;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ack_scope_item
  ON acknowledgements(
    handoff_id,
    COALESCE(supplemental_handoff_id, ''),
    item_type,
    item_id
  );
