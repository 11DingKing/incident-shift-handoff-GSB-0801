-- 003_supplement_handoffs.sql — 补充交接包：父子关联 + 差异快照
BEGIN;

-- 补充交接包显式关联父交接包
ALTER TABLE handoffs
  ADD COLUMN parent_handoff_id text REFERENCES handoffs (id);

-- 快照行类型：snapshot=首轮全量快照；added=父签收后新增；changed=父签收后发生变化
ALTER TABLE handoff_items
  ADD COLUMN change_kind text NOT NULL DEFAULT 'snapshot'
    CHECK (change_kind IN ('snapshot', 'added', 'changed')),
  ADD COLUMN diff jsonb; -- 与父快照的逐字段差异：{field: {from, to}}

CREATE INDEX idx_handoffs_parent ON handoffs (parent_handoff_id);

COMMIT;
