-- 004_seed_incident.sql
-- 初始事件 inc-gd-20260729-01：两个行动项与两条时间线事件。
-- 使用稳定 ID、明确责任方与发生时间；ON CONFLICT 保证可重复执行。

INSERT INTO incidents (id, title, severity, status, responsible_party, occurred_at)
VALUES (
  'inc-gd-20260729-01',
  '广东强降水与强对流应急事件',
  'high',
  'active',
  '应急指挥中心',
  '2026-07-29T10:00:00+08:00'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO action_items (id, incident_id, title, detail, status, responsible_party, occurred_at)
VALUES
  (
    'act-gd-20260729-01-a1',
    'inc-gd-20260729-01',
    '复核东侧绕行路线',
    '复核东侧绕行道路通行条件与导流标识，确认可承担主路分流流量。',
    'in_progress',
    '交通协调组',
    '2026-07-29T10:05:00+08:00'
  ),
  (
    'act-gd-20260729-01-a2',
    'inc-gd-20260729-01',
    '确认临时搭建物撤离结果',
    '逐点确认临时搭建物人员与物资撤离完成，排除坠损与漏电风险。',
    'open',
    '现场处置组',
    '2026-07-29T10:10:00+08:00'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO timeline_events (id, incident_id, kind, description, responsible_party, occurred_at)
VALUES
  (
    'tl-gd-20260729-01-e1',
    'inc-gd-20260729-01',
    'road_closure',
    '主路（G某段）因积水封闭，双向禁止通行。',
    '交通协调组',
    '2026-07-29T10:20:00+08:00'
  ),
  (
    'tl-gd-20260729-01-e2',
    'inc-gd-20260729-01',
    'evidence_intake',
    '现场巡查证据（积水深度照片与视频）入库。',
    '现场处置组',
    '2026-07-29T11:00:00+08:00'
  )
ON CONFLICT (id) DO NOTHING;
