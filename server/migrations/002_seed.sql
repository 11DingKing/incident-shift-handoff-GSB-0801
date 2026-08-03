-- 002_seed.sql — 初始事件 inc-gd-20260729-01（强降水与强对流，广东）
BEGIN;

INSERT INTO incidents (id, title, status, created_at) VALUES
  ('inc-gd-20260729-01', '强降水与强对流应急（广东 2026-07-29）', 'active',
   '2026-07-29T13:00:00+08:00');

INSERT INTO action_items (id, incident_id, title, owner, status, version, occurred_at, updated_at) VALUES
  ('ai-gd-20260729-01', 'inc-gd-20260729-01', '复核东侧绕行路线',       '交通保障组', 'open', 1,
   '2026-07-29T14:30:00+08:00', '2026-07-29T14:30:00+08:00'),
  ('ai-gd-20260729-02', 'inc-gd-20260729-01', '确认临时搭建物撤离结果', '现场处置组', 'open', 1,
   '2026-07-29T15:10:00+08:00', '2026-07-29T15:10:00+08:00');

INSERT INTO timeline_events (id, incident_id, handoff_id, kind, title, detail, owner, occurred_at, created_at) VALUES
  ('ev-gd-20260729-01', 'inc-gd-20260729-01', NULL, 'evidence', '主路封闭',
   '受强降水影响，东侧主路双向封闭，启动绕行预案。', '交管中心',
   '2026-07-29T13:45:00+08:00', '2026-07-29T13:45:00+08:00'),
  ('ev-gd-20260729-02', 'inc-gd-20260729-01', NULL, 'evidence', '现场证据入库',
   '现场影像与水位监测记录已归档，证据编号 EV-0729-A01～A17。', '证据管理组',
   '2026-07-29T16:05:00+08:00', '2026-07-29T16:05:00+08:00');

COMMIT;
