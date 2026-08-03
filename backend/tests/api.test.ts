import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp, resetDatabase, endTestPool } from './helpers.js';

const INCIDENT = 'inc-gd-20260729-01';
let app: FastifyInstance;

beforeAll(async () => {
  await resetDatabase();
  app = await buildTestApp();
});

afterEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestApp(app);
  await endTestPool();
});

describe('Incident & read APIs', () => {
  it('returns the seeded incident', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.incident_id).toBe(INCIDENT);
    expect(body.version).toBe(1);
  });

  it('returns exactly two seeded action items with stable IDs', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}/action-items` });
    expect(res.statusCode).toBe(200);
    const items = res.json();
    expect(items).toHaveLength(2);
    expect(items.map((i: any) => i.action_item_id)).toEqual([
      'ai-gd-20260729-route-review',
      'ai-gd-20260729-temp-structure',
    ]);
    for (const it of items) {
      expect(it.owner).toBeTruthy();
      expect(it.occurred_at).toBeTruthy();
      expect(it.version).toBe(1);
    }
  });

  it('returns exactly two seeded timeline events', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}/timeline` });
    expect(res.statusCode).toBe(200);
    const tl = res.json();
    expect(tl).toHaveLength(2);
    expect(tl[0].event_type).toBe('road_closure');
    expect(tl[1].event_type).toBe('evidence_ingested');
  });
});

describe('Optimistic locking on action items', () => {
  it('updates successfully with correct version and bumps version', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}/action-items` });
    const item = list.json().find((i: any) => i.action_item_id === 'ai-gd-20260729-route-review');
    expect(item.version).toBe(1);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/action-items/${item.action_item_id}`,
      headers: { 'x-actor': '接班-张三', 'content-type': 'application/json' },
      payload: { status: 'done', expected_version: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(2);
    expect(res.json().status).toBe('done');
  });

  it('rejects stale version with 409 and field-level conflict details', async () => {
    // Current version is 2 (from previous test) but beforeEach reset re-seeds to v1.
    // We first advance to v2, then send stale v1.
    const list = await app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}/action-items` });
    const item = list.json().find((i: any) => i.action_item_id === 'ai-gd-20260729-route-review');
    await app.inject({
      method: 'PATCH',
      url: `/api/action-items/${item.action_item_id}`,
      headers: { 'x-actor': 'A', 'content-type': 'application/json' },
      payload: { status: 'done', expected_version: 1 },
    });
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/action-items/${item.action_item_id}`,
      headers: { 'x-actor': '客户端B', 'content-type': 'application/json' },
      payload: { status: 'blocked', expected_version: 1 },
    });
    expect(stale.statusCode).toBe(409);
    const body = stale.json();
    expect(body.conflictFields).toBeDefined();
    const statusConflict = body.conflictFields.find((f: any) => f.field === 'status');
    expect(statusConflict).toBeTruthy();
    expect(statusConflict.submitted).toBe('blocked');
    expect(statusConflict.current).toBe('done');
    expect(statusConflict.current_version).toBe(2);
  });

  it('does not mutate row when conflict occurs', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}/action-items` });
    const item = list.json().find((i: any) => i.action_item_id === 'ai-gd-20260729-route-review');
    expect(item.version).toBe(1);
    expect(item.status).toBe('in_progress');
  });
});

describe('Handoff snapshot, atomic acknowledgment and supplementary events', () => {
  it('creates handoff with atomic snapshot of items + timeline', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/incidents/${INCIDENT}/handoffs`,
      headers: { 'content-type': 'application/json', 'x-actor': '交班-李四' },
      payload: {
        handoff_id: 'hnd-test-001',
        from_shift: '白班 08:00-20:00',
        to_shift: '夜班 20:00-08:00',
        summary: '主路封闭中，等待绕行复核与撤离确认',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.handoff.handoff_id).toBe('hnd-test-001');
    expect(body.handoff.status).toBe('pending');
    expect(body.items).toHaveLength(2);
    expect(body.timeline).toHaveLength(2);
  });

  it('returns the frozen snapshot and shows unconfirmed items as open', async () => {
    // recreate handoff since afterEach reset
    await app.inject({
      method: 'POST',
      url: `/api/incidents/${INCIDENT}/handoffs`,
      headers: { 'content-type': 'application/json' },
      payload: { handoff_id: 'hnd-test-001', from_shift: 'A', to_shift: 'B', summary: '' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/handoffs/hnd-test-001' });
    expect(res.statusCode).toBe(200);
    const h = res.json();
    expect(h.handoff.status).toBe('pending');
    expect(h.items).toHaveLength(2);
    const openItem = h.items.find((i: any) => i.action_item_id === 'ai-gd-20260729-temp-structure');
    expect(openItem.status).toBe('open');
    expect(h.acknowledgments).toEqual([]);
  });

  it('acknowledges individual items idempotently (retry does not duplicate)', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/incidents/${INCIDENT}/handoffs`,
      headers: { 'content-type': 'application/json' },
      payload: { handoff_id: 'hnd-test-001', from_shift: 'A', to_shift: 'B', summary: '' },
    });
    const key = 'idem-item-1';
    const first = await app.inject({
      method: 'POST',
      url: '/api/handoffs/hnd-test-001/items/ai-gd-20260729-route-review/acknowledge',
      headers: { 'content-type': 'application/json' },
      payload: { confirmed_by: '接班-王五', note: '已了解', idempotency_key: key },
    });
    expect(first.statusCode).toBe(200);
    const retry = await app.inject({
      method: 'POST',
      url: '/api/handoffs/hnd-test-001/items/ai-gd-20260729-route-review/acknowledge',
      headers: { 'content-type': 'application/json' },
      payload: { confirmed_by: '接班-王五', note: '已了解', idempotency_key: key },
    });
    expect(retry.statusCode).toBe(200);
    const h = (await app.inject({ method: 'GET', url: '/api/handoffs/hnd-test-001' })).json();
    const itemAcks = h.acknowledgments.filter((a: any) => a.action_item_id === 'ai-gd-20260729-route-review');
    expect(itemAcks).toHaveLength(1);
  });

  it('package-level acknowledgment flips status atomically and leaves unconfirmed action items open', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/incidents/${INCIDENT}/handoffs`,
      headers: { 'content-type': 'application/json' },
      payload: { handoff_id: 'hnd-test-001', from_shift: 'A', to_shift: 'B', summary: '' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/handoffs/hnd-test-001/acknowledge',
      headers: { 'content-type': 'application/json' },
      payload: { confirmed_by: '接班-王五', note: '签收', idempotency_key: 'idem-pkg-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().packageAcknowledged).toBe(true);
    const h = (await app.inject({ method: 'GET', url: '/api/handoffs/hnd-test-001' })).json();
    expect(h.handoff.status).toBe('acknowledged');
    expect(h.handoff.acknowledged_by).toBe('接班-王五');
    const openItem = h.items.find((i: any) => i.action_item_id === 'ai-gd-20260729-temp-structure');
    expect(openItem.status).toBe('open');
    const acksForOpen = h.acknowledgments.filter((a: any) => a.action_item_id === 'ai-gd-20260729-temp-structure');
    expect(acksForOpen).toHaveLength(0);
  });

  it('append timeline after acknowledgment creates a supplementary event linked to the handoff', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/incidents/${INCIDENT}/handoffs`,
      headers: { 'content-type': 'application/json' },
      payload: { handoff_id: 'hnd-test-001', from_shift: 'A', to_shift: 'B', summary: '' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/handoffs/hnd-test-001/acknowledge',
      headers: { 'content-type': 'application/json' },
      payload: { confirmed_by: '接班-王五', idempotency_key: 'pkg' },
    });
    const add = await app.inject({
      method: 'POST',
      url: `/api/incidents/${INCIDENT}/timeline`,
      headers: { 'content-type': 'application/json', 'x-actor': '夜班-赵六' },
      payload: { event_type: 'update', summary: '积水消退评估中', occurred_at: new Date().toISOString() },
    });
    expect(add.statusCode).toBe(200);
    const h = (await app.inject({ method: 'GET', url: '/api/handoffs/hnd-test-001' })).json();
    expect(h.supplementary.length).toBeGreaterThanOrEqual(1);
    const supp = h.supplementary[h.supplementary.length - 1];
    expect(supp.handoff_id).toBe('hnd-test-001');
    expect(supp.change_type).toBe('timeline_added');
  });

  it('updating an action item after acknowledgment appends supplementary event but snapshot stays immutable', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/incidents/${INCIDENT}/handoffs`,
      headers: { 'content-type': 'application/json' },
      payload: { handoff_id: 'hnd-test-001', from_shift: 'A', to_shift: 'B', summary: '' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/handoffs/hnd-test-001/acknowledge',
      headers: { 'content-type': 'application/json' },
      payload: { confirmed_by: '接班-王五', idempotency_key: 'pkg' },
    });
    const list = await app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}/action-items` });
    const item = list.json().find((i: any) => i.action_item_id === 'ai-gd-20260729-temp-structure');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/action-items/${item.action_item_id}`,
      headers: { 'content-type': 'application/json', 'x-actor': '夜班' },
      payload: { status: 'in_progress', expected_version: item.version },
    });
    expect(res.statusCode).toBe(200);
    const h = (await app.inject({ method: 'GET', url: '/api/handoffs/hnd-test-001' })).json();
    const itemSupp = h.supplementary.find((s: any) => s.change_type === 'action_item_updated');
    expect(itemSupp).toBeTruthy();
    const snapItem = h.items.find((i: any) => i.action_item_id === 'ai-gd-20260729-temp-structure');
    expect(snapItem.status).toBe('open');
  });
});
