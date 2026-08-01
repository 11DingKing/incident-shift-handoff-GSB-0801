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
  ctx = await makeContext('handoff_test_conc');
});
after(async () => {
  await closeContext(ctx);
});

test('并发：两个客户端用同一版本更新同一行动项，恰好一成一败', async () => {
  const patch = (status: string, by: string) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/action-items/${ITEM_ROUTE}`,
      payload: { status, expectedVersion: 1, updatedBy: by },
    });
  const [a, b] = await Promise.all([
    patch('in_progress', '客户端A'),
    patch('done', '客户端B'),
  ]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [200, 409]);
  const loser = a.statusCode === 409 ? a : b;
  assert.equal(loser.json().error.code, 'VERSION_CONFLICT');

  const inc = await ctx.app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}` });
  const item = inc
    .json()
    .actionItems.find((i: { id: string }) => i.id === ITEM_ROUTE);
  assert.equal(item.version, 2); // 只成功一次
});

test('并发：两人同时签收同一交接包，只有一份快照与一条审计', async () => {
  const handoffId = await createHandoff(ctx.app);
  const [a, b] = await Promise.all([
    signHandoff(ctx.app, handoffId, '班长B'),
    signHandoff(ctx.app, handoffId, '班长C'),
  ]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [200, 409]);

  const items = await ctx.pool.query(
    'SELECT * FROM handoff_items WHERE handoff_id = $1',
    [handoffId],
  );
  assert.equal(items.rowCount, 2); // 两个行动项各一份快照
  const audits = await ctx.pool.query(
    `SELECT * FROM timeline_events WHERE handoff_id = $1 AND kind = 'audit'`,
    [handoffId],
  );
  assert.equal(audits.rowCount, 1);
});

test('并发：两人同时确认同一项，只记录首次确认', async () => {
  const handoffId = await createHandoff(ctx.app);
  await signHandoff(ctx.app, handoffId);
  const url = `/api/handoffs/${handoffId}/items/${ITEM_ROUTE}/confirm`;
  const confirm = (by: string) =>
    ctx.app.inject({ method: 'POST', url, payload: { confirmedBy: by } });
  const [a, b] = await Promise.all([confirm('接班人甲'), confirm('接班人乙')]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  const winners = [a, b].filter((r) => r.json().alreadyConfirmed === false);
  assert.equal(winners.length, 1);

  const row = await ctx.pool.query(
    'SELECT confirmed_by FROM handoff_items WHERE handoff_id = $1 AND action_item_id = $2',
    [handoffId, ITEM_ROUTE],
  );
  assert.equal(row.rows[0].confirmed_by, winners[0].json().item.confirmed_by);
  const audits = await ctx.pool.query(
    `SELECT * FROM timeline_events WHERE handoff_id = $1 AND title = '行动项已确认'`,
    [handoffId],
  );
  assert.equal(audits.rowCount, 1);
});

test('交叉竞争：签收后一方更新行动项、另一方确认同一项，两者都成功且互不污染', async () => {
  const handoffId = await createHandoff(ctx.app);
  await signHandoff(ctx.app, handoffId);

  const inc = await ctx.app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}` });
  const item = inc
    .json()
    .actionItems.find((i: { id: string }) => i.id === ITEM_SCAFFOLD);

  const [patchRes, confirmRes] = await Promise.all([
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/action-items/${ITEM_SCAFFOLD}`,
      payload: { status: 'done', expectedVersion: item.version, updatedBy: '现场处置组' },
    }),
    ctx.app.inject({
      method: 'POST',
      url: `/api/handoffs/${handoffId}/items/${ITEM_SCAFFOLD}/confirm`,
      payload: { confirmedBy: '接班人乙' },
    }),
  ]);
  assert.equal(patchRes.statusCode, 200);
  assert.equal(confirmRes.statusCode, 200);

  const detail = await ctx.app.inject({
    method: 'GET',
    url: `/api/handoffs/${handoffId}`,
  });
  const { items, supplements } = detail.json();
  const snap = items.find((i: { id: string }) => i.id === ITEM_SCAFFOLD);
  assert.equal(snap.confirmed, true);
  assert.equal(snap.status_at_sign, 'open'); // 快照保持签收时刻状态
  assert.equal(supplements.length, 1); // 更新被追加为补充事件
  assert.equal(supplements[0].handoff_id, handoffId);
});

test('并发：同一幂等键并发提交，仅生效一次', async () => {
  const handoffId = await createHandoff(ctx.app);
  await signHandoff(ctx.app, handoffId);
  const headers = { 'idempotency-key': 'race-key-001' };
  const post = () =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/handoffs/${handoffId}/supplements`,
      headers,
      payload: { title: '并发补充', detail: '', owner: '气象联络员' },
    });
  const [a, b] = await Promise.all([post(), post()]);
  assert.ok([200, 201].includes(a.statusCode));
  assert.ok([200, 201].includes(b.statusCode));
  assert.equal(a.json().event.id, b.json().event.id); // 重放同一响应
  const rows = await ctx.pool.query(
    `SELECT * FROM timeline_events WHERE handoff_id = $1 AND title = '并发补充'`,
    [handoffId],
  );
  assert.equal(rows.rowCount, 1); // 并发同键严格只生效一次
});
