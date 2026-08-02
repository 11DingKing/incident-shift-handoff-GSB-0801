import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp, resetDatabase, endTestPool, getTestPool } from './helpers.js';

const INCIDENT = 'inc-gd-20260729-01';
let app: FastifyInstance;

beforeAll(async () => {
  await resetDatabase();
  app = await buildTestApp();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestApp(app);
  await endTestPool();
});

describe('Concurrency: two clients racing on one action item', () => {
  it('allows exactly one winner when two PATCHes race on version 1', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}/action-items` });
    const item = list.json().find((i: any) => i.action_item_id === 'ai-gd-20260729-route-review');

    const patch = (actor: string, status: string) =>
      app.inject({
        method: 'PATCH',
        url: `/api/action-items/${item.action_item_id}`,
        headers: { 'content-type': 'application/json', 'x-actor': actor },
        payload: { status, expected_version: 1 },
      });

    const [a, b] = await Promise.all([
      patch('client-A', 'done'),
      patch('client-B', 'blocked'),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const winner = a.statusCode === 200 ? a.json() : b.json();
    const loser = a.statusCode === 409 ? a.json() : b.json();

    expect(winner.version).toBe(2);
    expect(['done', 'blocked']).toContain(winner.status);
    expect(loser.conflictFields).toBeDefined();
    const field = loser.conflictFields.find((f: any) => f.field === 'status');
    expect(field).toBeTruthy();
    expect(field.current_version).toBe(2);
    expect(field.current).toBe(winner.status);

    const final = (await app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}/action-items` }))
      .json()
      .find((i: any) => i.action_item_id === item.action_item_id);
    expect(final.version).toBe(2);
    expect(final.status).toBe(winner.status);
  });

  it('the loser can rebase and apply its change on version 2', async () => {
    // Advance to v2 first
    const list = await app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}/action-items` });
    const item = list.json().find((i: any) => i.action_item_id === 'ai-gd-20260729-route-review');
    await app.inject({
      method: 'PATCH',
      url: `/api/action-items/${item.action_item_id}`,
      headers: { 'content-type': 'application/json', 'x-actor': 'A' },
      payload: { status: 'done', expected_version: 1 },
    });
    const list2 = await app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}/action-items` });
    const item2 = list2.json().find((i: any) => i.action_item_id === 'ai-gd-20260729-route-review');
    expect(item2.version).toBe(2);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/action-items/${item2.action_item_id}`,
      headers: { 'content-type': 'application/json', 'x-actor': 'client-B-rebased' },
      payload: { status: 'blocked', expected_version: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(3);
    expect(res.json().status).toBe('blocked');
  });
});

describe('Concurrency: duplicate acknowledgments cannot create two rows', () => {
  it('two simultaneous package-level acks result in exactly one state flip', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/incidents/${INCIDENT}/handoffs`,
      headers: { 'content-type': 'application/json', 'x-actor': '交班' },
      payload: { handoff_id: 'hnd-concurrent', from_shift: 'A', to_shift: 'B', summary: '并发签收测试' },
    });

    const ack = () =>
      app.inject({
        method: 'POST',
        url: '/api/handoffs/hnd-concurrent/acknowledge',
        headers: { 'content-type': 'application/json' },
        payload: { confirmed_by: '接班-并发', idempotency_key: 'same-key' },
      });

    const [r1, r2] = await Promise.all([ack(), ack()]);
    expect([r1.statusCode, r2.statusCode].every((c) => c === 200)).toBe(true);

    // Exactly one of the two concurrent calls should have performed the status flip.
    const bodies = [r1.json(), r2.json()];
    const flipCount = bodies.filter((b) => b.packageAcknowledged === true).length;
    expect(flipCount).toBe(1);

    // The handoff must be acknowledged with version bumped exactly once.
    const h = await app.inject({ method: 'GET', url: '/api/handoffs/hnd-concurrent' });
    expect(h.statusCode).toBe(200);
    const handoff = h.json();
    expect(handoff.handoff.status).toBe('acknowledged');
    expect(handoff.handoff.version).toBe(2);

    // Exactly one package-level acknowledgment row exists.
    const pkgAcks = handoff.acknowledgments.filter((a: any) => a.action_item_id === null);
    expect(pkgAcks).toHaveLength(1);
  });
});

describe('Concurrency: atomic handoff snapshot cannot interleave with item update', () => {
  it('snapshot and item update are serialized; either old or new value but not a mix', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/incidents/${INCIDENT}/action-items` });
    const item = list.json().find((i: any) => i.action_item_id === 'ai-gd-20260729-temp-structure');

    const createHandoff = () =>
      app.inject({
        method: 'POST',
        url: `/api/incidents/${INCIDENT}/handoffs`,
        headers: { 'content-type': 'application/json' },
        payload: { handoff_id: 'hnd-atomic', from_shift: 'A', to_shift: 'B', summary: '原子性' },
      });

    const updateItem = () =>
      app.inject({
        method: 'PATCH',
        url: `/api/action-items/${item.action_item_id}`,
        headers: { 'content-type': 'application/json', 'x-actor': '并发更新' },
        payload: { status: 'done', expected_version: 1 },
      });

    const [hRes, uRes] = await Promise.all([createHandoff(), updateItem()]);
    expect(hRes.statusCode).toBe(200);
    expect(uRes.statusCode).toBe(200);

    const h = (await app.inject({ method: 'GET', url: '/api/handoffs/hnd-atomic' })).json();
    const snap = h.items.find((i: any) => i.action_item_id === item.action_item_id);
    expect(['open', 'done']).toContain(snap.status);
    if (snap.status === 'open') {
      expect(snap.snapshot_version).toBe(1);
    } else {
      expect(snap.snapshot_version).toBe(2);
    }
  });
});
