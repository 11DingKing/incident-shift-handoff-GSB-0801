-- 004_seed_round2.sql — 绕行路线重新开放 + 新增警戒复核行动项
BEGIN;

INSERT INTO action_items (id, incident_id, title, owner, status, version, occurred_at, updated_at) VALUES
  ('ai-gd-20260729-03', 'inc-gd-20260729-01', '复核恢复通行后的现场警戒', '现场处置组', 'open', 1,
   '2026-07-30T09:20:00+08:00', '2026-07-30T09:20:00+08:00')
ON CONFLICT (id) DO NOTHING;

INSERT INTO timeline_events (id, incident_id, handoff_id, kind, title, detail, owner, occurred_at, created_at) VALUES
  ('ev-gd-20260729-03', 'inc-gd-20260729-01', NULL, 'evidence', '东侧绕行路线重新开放',
   '降水减弱，东侧主路解除封闭，绕行路线恢复通行。', '交管中心',
   '2026-07-30T09:00:00+08:00', '2026-07-30T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

COMMIT;
