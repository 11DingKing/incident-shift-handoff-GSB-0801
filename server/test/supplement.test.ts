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

const ITEM_GUARD = 'ai-gd-20260729-03';

let ctx: TestContext;
before(async () => {
  ctx = await makeContext('handoff_test_supp');
});
after(async () => {
  await closeContext(ctx);
});

test('第二轮种子：新增行动项与时间线事件入库', async () => {
  const inc = await ctx.app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}` });
  assert.equal(inc.json().actionItems.length, 3);
  const tl = await ctx.app.inject({
    method: 'GET',
    url: `/api/incidents/${INCIDENT}/timeline`,
  });
  const titles = tl.json().events.map((e: { title: string }) => e.title);
  assert.ok(titles.includes('东侧绕行路线重新开放'));
});

async function createChild(
  parentId: string,
  key?: string,
): Promise<{ statusCode: number; id?: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/incidents/${INCIDENT}/handoffs`,
    headers: key ? { 'idempotency-key': key } : {},
    payload: {
      fromShift: '夜班',
      toShift: '次日白班',
      note: '补充交接',
      createdBy: '班长B',
      parentHandoffId: parentId,
    },
  });
  const body = res.json();
  return { statusCode: res.statusCode, id: body.handoff?.id };
}

test('补充包校验：父包不存在/未签收被拒绝', async () => {
  const missing = await createChild('ho-不存在');
  assert.equal(missing.statusCode, 404);
  const draftId = await createHandoff(ctx.app);
  const notSigned = await createChild(draftId);
  assert.equal(notSigned.statusCode, 409);
  assert.equal(
    (await ctx.app.inject({ method: 'GET', url: `/api/handoffs/${draftId}` })).json()
      .handoff.status,
    'draft',
  );
});

test('同一幂等键创建补充包：只产生一个', async () => {
  const parentId = await createHandoff(ctx.app);
  await signHandoff(ctx.app, parentId);
  const [a, b] = await Promise.all([
    createChild(parentId, 'child-create-key'),
    createChild(parentId, 'child-create-key'),
  ]);
  assert.equal(a.id, b.id);
  const rows = await ctx.pool.query(
    'SELECT * FROM handoffs WHERE parent_handoff_id = $1',
    [parentId],
  );
  assert.equal(rows.rowCount, 1);
});

test('补充包签收：只快照新增/变化项并保存逐字段差异，父包保持不变', async () => {
  // 父包签收（快照 3 项），并确认其中一项
  const parentId = await createHandoff(ctx.app);
  await signHandoff(ctx.app, parentId);
  await ctx.app.inject({
    method: 'POST',
    url: `/api/handoffs/${parentId}/items/${ITEM_SCAFFOLD}/confirm`,
    payload: { confirmedBy: '接班人X' },
  });
  const parentBefore = (
    await ctx.pool.query('SELECT * FROM handoffs WHERE id = $1', [parentId])
  ).rows[0];

  // 父签收之后：ai-01 状态变化；ai-03 负责人变化；新增一项
  await ctx.app.inject({
    method: 'PATCH',
    url: `/api/action-items/${ITEM_ROUTE}`,
    payload: { status: 'in_progress', expectedVersion: 1 },
  });
  await ctx.app.inject({
    method: 'PATCH',
    url: `/api/action-items/${ITEM_GUARD}`,
    payload: { owner: '警戒巡查组', expectedVersion: 1 },
  });
  await ctx.pool.query(
    `INSERT INTO action_items (id, incident_id, title, owner, status, version, occurred_at, updated_at)
     VALUES ('ai-gd-20260729-04', $1, '新增排水点巡查', '排水作业组', 'open', 1, now(), now())`,
    [INCIDENT],
  );

  // 创建 + 签收补充包（带幂等键，模拟断线重试）
  const child = await createChild(parentId, 'child-key-1');
  assert.equal(child.statusCode, 201);
  const signKey = { 'idempotency-key': 'child-sign-key-1' };
  const s1 = await ctx.app.inject({
    method: 'POST',
    url: `/api/handoffs/${child.id}/sign`,
    headers: signKey,
    payload: { signedBy: '班长C', expectedVersion: 1 },
  });
  assert.equal(s1.statusCode, 200);
  assert.equal(s1.json().snapshotCount, 3); // 2 changed + 1 added
  const s2 = await ctx.app.inject({
    method: 'POST',
    url: `/api/handoffs/${child.id}/sign`,
    headers: signKey,
    payload: { signedBy: '班长C', expectedVersion: 1 },
  });
  assert.equal(s2.statusCode, 200); // 重放首次响应
  assert.equal(s2.json().handoff.id, s1.json().handoff.id);

  // 差异快照内容
  const snap = await ctx.pool.query(
    'SELECT * FROM handoff_items WHERE handoff_id = $1 ORDER BY action_item_id',
    [child.id],
  );
  assert.equal(snap.rowCount, 3); // 严格一组
  const byId = new Map(snap.rows.map((r) => [r.action_item_id, r]));
  assert.equal(byId.get(ITEM_ROUTE).change_kind, 'changed');
  assert.deepEqual(byId.get(ITEM_ROUTE).diff.status, { from: 'open', to: 'in_progress' });
  assert.equal(byId.get(ITEM_GUARD).change_kind, 'changed');
  assert.deepEqual(byId.get(ITEM_GUARD).diff.owner, {
    from: '现场处置组',
    to: '警戒巡查组',
  });
  assert.equal(byId.get('ai-gd-20260729-04').change_kind, 'added');
  assert.deepEqual(byId.get('ai-gd-20260729-04').diff.title, {
    from: null,
    to: '新增排水点巡查',
  });
  assert.ok(!byId.has(ITEM_SCAFFOLD)); // 未变化项不进快照
  for (const row of snap.rows) assert.equal(row.confirmed, false); // 不自动确认/关闭

  // 审计事件仅一条
  const audits = await ctx.pool.query(
    `SELECT * FROM timeline_events WHERE handoff_id = $1 AND kind = 'audit'`,
    [child.id],
  );
  assert.equal(audits.rowCount, 1);
  assert.equal(audits.rows[0].title, '补充交接包已签收');
  assert.ok(audits.rows[0].detail.includes(parentId));

  // 父包行、快照、确认记录完全不变
  const parentAfter = (
    await ctx.pool.query('SELECT * FROM handoffs WHERE id = $1', [parentId])
  ).rows[0];
  assert.equal(parentAfter.version, parentBefore.version);
  assert.equal(parentAfter.signed_at?.toISOString(), parentBefore.signed_at?.toISOString());
  const parentItems = await ctx.pool.query(
    'SELECT * FROM handoff_items WHERE handoff_id = $1 ORDER BY action_item_id',
    [parentId],
  );
  assert.equal(parentItems.rowCount, 3);
  const pScaffold = parentItems.rows.find((r) => r.action_item_id === ITEM_SCAFFOLD);
  assert.equal(pScaffold.confirmed, true);
  assert.equal(pScaffold.confirmed_by, '接班人X');
  const pRoute = parentItems.rows.find((r) => r.action_item_id === ITEM_ROUTE);
  assert.equal(pRoute.status_at_sign, 'open'); // 父快照仍是签收时刻状态
  assert.equal(pRoute.version_at_sign, 1);

  // GET 对比视图
  const detail = await ctx.app.inject({ method: 'GET', url: `/api/handoffs/${child.id}` });
  const { parent, comparison } = detail.json();
  assert.equal(parent.id, parentId);
  assert.equal(comparison.added.length, 1);
  assert.equal(comparison.changed.length, 2);
  assert.equal(comparison.unchanged.length, 1);
  assert.equal(comparison.unchanged[0].id, ITEM_SCAFFOLD);
});

test('旧版本签收补充包：409 且不产生差异快照', async () => {
  const parentId = await createHandoff(ctx.app);
  await signHandoff(ctx.app, parentId);
  const child = await createChild(parentId);
  const res = await signHandoff(ctx.app, child.id!, '班长C', 99);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'VERSION_CONFLICT');
  const snap = await ctx.pool.query(
    'SELECT * FROM handoff_items WHERE handoff_id = $1',
    [child.id],
  );
  assert.equal(snap.rowCount, 0);
});

test('并发签收补充包：一成一败，一组快照一条审计', async () => {
  const parentId = await createHandoff(ctx.app);
  await signHandoff(ctx.app, parentId);
  await ctx.app.inject({
    method: 'PATCH',
    url: `/api/action-items/${ITEM_ROUTE}`,
    payload: { status: 'done', expectedVersion: 2 },
  });
  const child = await createChild(parentId);
  const [a, b] = await Promise.all([
    signHandoff(ctx.app, child.id!, '班长C'),
    signHandoff(ctx.app, child.id!, '班长D'),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  const snap = await ctx.pool.query(
    'SELECT * FROM handoff_items WHERE handoff_id = $1',
    [child.id],
  );
  assert.equal(snap.rowCount, 1); // 只有 ai-01 changed
  const audits = await ctx.pool.query(
    `SELECT * FROM timeline_events WHERE handoff_id = $1 AND kind = 'audit'`,
    [child.id],
  );
  assert.equal(audits.rowCount, 1);
});
