import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  closeContext,
  createHandoff,
  INCIDENT,
  ITEM_ROUTE,
  ITEM_SCAFFOLD,
  makeContext,
  signHandoff,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
before(async () => {
  ctx = await makeContext('handoff_test_api');
});
after(async () => {
  await closeContext(ctx);
});

test('种子数据：事件、行动项、时间线均有稳定 ID、责任方与发生时间', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.incident.id, INCIDENT);
  assert.equal(body.actionItems.length, 3);
  const titles = body.actionItems.map((i: { title: string }) => i.title);
  assert.deepEqual(titles, [
    '复核东侧绕行路线',
    '确认临时搭建物撤离结果',
    '复核恢复通行后的现场警戒',
  ]);
  for (const item of body.actionItems) {
    assert.ok(item.id && item.owner && item.occurred_at);
    assert.equal(item.status, 'open');
    assert.equal(item.version, 1);
  }

  const tl = await ctx.app.inject({
    method: 'GET',
    url: `/api/incidents/${INCIDENT}/timeline`,
  });
  const events = tl.json().events;
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e: { title: string }) => e.title),
    ['主路封闭', '现场证据入库', '东侧绕行路线重新开放'],
  );
  for (const e of events) {
    assert.ok(e.id && e.owner && e.occurred_at);
    assert.equal(e.kind, 'evidence');
  }
});

test('行动项更新：版本匹配成功并递增版本号', async () => {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/action-items/${ITEM_ROUTE}`,
    payload: { status: 'in_progress', expectedVersion: 1, updatedBy: '值班员甲' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().actionItem.status, 'in_progress');
  assert.equal(res.json().actionItem.version, 2);
});

test('旧乐观版本返回 409 字段级冲突，不静默覆盖', async () => {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/action-items/${ITEM_ROUTE}`,
    payload: { title: '复核东侧绕行路线（改）', status: 'done', expectedVersion: 1 },
  });
  assert.equal(res.statusCode, 409);
  const err = res.json().error;
  assert.equal(err.code, 'VERSION_CONFLICT');
  assert.equal(err.currentVersion, 2);
  // attempted status=done 与当前 in_progress 不同 → 字段级冲突；title 未变 → 也列出
  const fields = err.conflicts.map((c: { field: string }) => c.field).sort();
  assert.deepEqual(fields, ['status', 'title']);
  const statusConflict = err.conflicts.find(
    (c: { field: string }) => c.field === 'status',
  );
  assert.equal(statusConflict.current, 'in_progress');
  assert.equal(statusConflict.attempted, 'done');
});

test('非法状态枚举被拒绝', async () => {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/action-items/${ITEM_ROUTE}`,
    payload: { status: 'closed', expectedVersion: 2 },
  });
  assert.equal(res.statusCode, 400);
});

test('签收：快照 + 状态 + 审计事件原子产生；未确认项不自动关闭', async () => {
  const handoffId = await createHandoff(ctx.app);
  const res = await signHandoff(ctx.app, handoffId);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().handoff.status, 'signed');
  assert.equal(res.json().snapshotCount, 3);

  const detail = await ctx.app.inject({
    method: 'GET',
    url: `/api/handoffs/${handoffId}`,
  });
  const { items } = detail.json();
  assert.equal(items.length, 3);
  for (const item of items) {
    assert.equal(item.confirmed, false);
    assert.equal(item.status_at_sign, item.id === ITEM_ROUTE ? 'in_progress' : 'open');
    assert.ok(item.version_at_sign >= 1);
  }

  // 审计事件关联交接包
  const rows = (
    await ctx.pool.query(
      `SELECT * FROM timeline_events WHERE handoff_id = $1 AND kind = 'audit'`,
      [handoffId],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '交接包已签收');

  // 行动项本身状态不被签收改动
  const inc = await ctx.app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}` });
  const route = inc
    .json()
    .actionItems.find((i: { id: string }) => i.id === ITEM_ROUTE);
  assert.equal(route.status, 'in_progress');
});

test('签收失败（旧版本）不产生任何快照或审计记录（原子性反向验证）', async () => {
  const handoffId = await createHandoff(ctx.app);
  const res = await signHandoff(ctx.app, handoffId, '班长B', 99);
  assert.equal(res.statusCode, 409);
  const items = await ctx.pool.query(
    'SELECT * FROM handoff_items WHERE handoff_id = $1',
    [handoffId],
  );
  assert.equal(items.rowCount, 0);
  const audits = await ctx.pool.query(
    `SELECT * FROM timeline_events WHERE handoff_id = $1`,
    [handoffId],
  );
  assert.equal(audits.rowCount, 0);
  const h = await ctx.pool.query('SELECT status FROM handoffs WHERE id = $1', [
    handoffId,
  ]);
  assert.equal(h.rows[0].status, 'draft');
});

test('已签收交接包不可修改、不可重复签收', async () => {
  const handoffId = await createHandoff(ctx.app);
  await signHandoff(ctx.app, handoffId);
  const patch = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/handoffs/${handoffId}`,
    payload: { note: '篡改', expectedVersion: 2 },
  });
  assert.equal(patch.statusCode, 409);
  assert.equal(patch.json().error.code, 'HANDOFF_LOCKED');
  const resign = await signHandoff(ctx.app, handoffId, '班长C', 2);
  assert.equal(resign.statusCode, 409);
  assert.equal(resign.json().error.code, 'HANDOFF_ALREADY_SIGNED');
});

test('逐项确认幂等：重复确认返回首次结果，不产生第二条审计', async () => {
  const handoffId = await createHandoff(ctx.app);
  await signHandoff(ctx.app, handoffId);
  const url = `/api/handoffs/${handoffId}/items/${ITEM_SCAFFOLD}/confirm`;
  const first = await ctx.app.inject({
    method: 'POST',
    url,
    payload: { confirmedBy: '接班人乙' },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().alreadyConfirmed, false);
  const firstAt = first.json().item.confirmed_at;

  const second = await ctx.app.inject({
    method: 'POST',
    url,
    payload: { confirmedBy: '另一个人' },
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().alreadyConfirmed, true);
  assert.equal(second.json().item.confirmed_by, '接班人乙');
  assert.equal(second.json().item.confirmed_at, firstAt);

  const audits = await ctx.pool.query(
    `SELECT * FROM timeline_events WHERE handoff_id = $1 AND title = '行动项已确认'`,
    [handoffId],
  );
  assert.equal(audits.rowCount, 1);
});

test('未签收的交接包不能确认', async () => {
  const handoffId = await createHandoff(ctx.app);
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/handoffs/${handoffId}/items/${ITEM_ROUTE}/confirm`,
    payload: { confirmedBy: '接班人乙' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'HANDOFF_NOT_SIGNED');
});

test('签收后行动项更新自动追加补充事件并关联原交接包，快照视图不变', async () => {
  const handoffId = await createHandoff(ctx.app);
  await signHandoff(ctx.app, handoffId);

  const before = await ctx.app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}` });
  const item = before
    .json()
    .actionItems.find((i: { id: string }) => i.id === ITEM_SCAFFOLD);
  const patch = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/action-items/${ITEM_SCAFFOLD}`,
    payload: { status: 'done', expectedVersion: item.version, updatedBy: '现场处置组' },
  });
  assert.equal(patch.statusCode, 200);

  const detail = await ctx.app.inject({
    method: 'GET',
    url: `/api/handoffs/${handoffId}`,
  });
  const { items, supplements } = detail.json();
  assert.equal(supplements.length, 1);
  assert.equal(supplements[0].handoff_id, handoffId);
  assert.equal(supplements[0].kind, 'supplement');
  const snapshot = items.find((i: { id: string }) => i.id === ITEM_SCAFFOLD);
  assert.equal(snapshot.status_at_sign, 'open'); // 快照视图不被后续变化污染
});

test('手动追加补充事件 + 幂等键重放：重复提交不产生第二条', async () => {
  const handoffId = await createHandoff(ctx.app);
  await signHandoff(ctx.app, handoffId);
  const headers = { 'idempotency-key': 'supp-retry-001' };
  const payload = { title: '雨量复测 62mm/h', detail: '超出阈值', owner: '气象联络员' };
  const first = await ctx.app.inject({
    method: 'POST',
    url: `/api/handoffs/${handoffId}/supplements`,
    headers,
    payload,
  });
  assert.equal(first.statusCode, 201);
  const second = await ctx.app.inject({
    method: 'POST',
    url: `/api/handoffs/${handoffId}/supplements`,
    headers,
    payload,
  });
  assert.equal(second.statusCode, 201);
  assert.equal(second.json().event.id, first.json().event.id);

  const rows = await ctx.pool.query(
    `SELECT * FROM timeline_events WHERE handoff_id = $1 AND kind = 'supplement' AND title = '雨量复测 62mm/h'`,
    [handoffId],
  );
  assert.equal(rows.rowCount, 1);

  // 同一幂等键用于不同路径 → 422
  const reused = await ctx.app.inject({
    method: 'POST',
    url: `/api/handoffs/${handoffId}/items/${ITEM_ROUTE}/confirm`,
    headers,
    payload: { confirmedBy: 'x' },
  });
  assert.equal(reused.statusCode, 422);
});

test('确认也支持幂等键：断线重试不会多出第二份确认', async () => {
  const handoffId = await createHandoff(ctx.app);
  await signHandoff(ctx.app, handoffId);
  const headers = { 'idempotency-key': 'confirm-retry-001' };
  const url = `/api/handoffs/${handoffId}/items/${ITEM_ROUTE}/confirm`;
  const first = await ctx.app.inject({
    method: 'POST',
    url,
    headers,
    payload: { confirmedBy: '接班人乙' },
  });
  const retry = await ctx.app.inject({
    method: 'POST',
    url,
    headers,
    payload: { confirmedBy: '接班人乙' },
  });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().item.confirmed_at, first.json().item.confirmed_at);
  const audits = await ctx.pool.query(
    `SELECT * FROM timeline_events WHERE handoff_id = $1 AND title = '行动项已确认'`,
    [handoffId],
  );
  assert.equal(audits.rowCount, 1);
});
