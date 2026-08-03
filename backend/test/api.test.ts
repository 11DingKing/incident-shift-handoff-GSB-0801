import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, ensureSchema, resetData } from './helpers.js';

const INC = 'inc-gd-20260729-01';
const A1 = 'act-gd-20260729-01-a1';
const A2 = 'act-gd-20260729-01-a2';

let app: FastifyInstance;

beforeAll(async () => {
  ensureSchema();
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

beforeEach(async () => {
  await resetData();
});

async function inject(method: string, url: string, payload?: unknown, headers?: Record<string, string>) {
  const res = await app.inject({
    method: method as never,
    url,
    payload: payload as never,
    headers: { 'content-type': 'application/json', ...headers },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, body: res.json() as any };
}

describe('incident bundle', () => {
  it('returns the seeded incident with 2 action items and 2 timeline events', async () => {
    const { status, body } = await inject('GET', `/api/incidents/${INC}`);
    expect(status).toBe(200);
    expect(body.incident.id).toBe(INC);
    expect(body.action_items).toHaveLength(2);
    expect(body.timeline_events).toHaveLength(2);
  });

  it('404s for an unknown incident', async () => {
    const { status } = await inject('GET', '/api/incidents/nope');
    expect(status).toBe(404);
  });
});

describe('optimistic locking on action items', () => {
  it('accepts an update at the expected version and bumps the version', async () => {
    const { status, body } = await inject('PATCH', `/api/incidents/${INC}/action-items/${A1}`, {
      expected_version: 1,
      status: 'done',
      actor: '李四',
    });
    expect(status).toBe(200);
    expect(body.status).toBe('done');
    expect(body.version).toBe(2);
  });

  it('returns a field-level 409 conflict for a stale version instead of overwriting', async () => {
    // First writer wins.
    await inject('PATCH', `/api/incidents/${INC}/action-items/${A1}`, {
      expected_version: 1,
      status: 'done',
      actor: '甲',
    });
    // Second writer used the stale version 1.
    const { status, body } = await inject('PATCH', `/api/incidents/${INC}/action-items/${A1}`, {
      expected_version: 1,
      status: 'blocked',
      title: '改标题',
      actor: '乙',
    });
    expect(status).toBe(409);
    expect(body.error).toBe('version_conflict');
    expect(body.expected_version).toBe(1);
    expect(body.actual_version).toBe(2);
    // The status field the loser tried to change is reported with the current value.
    expect(body.conflicts.status).toEqual({ current: 'done' });
    // And it did NOT silently overwrite: current status stays 'done'.
    expect(body.current.status).toBe('done');
  });

  it('serializes two concurrent updates so exactly one wins', async () => {
    const [r1, r2] = await Promise.all([
      inject('PATCH', `/api/incidents/${INC}/action-items/${A2}`, {
        expected_version: 1,
        status: 'in_progress',
        actor: 'client-A',
      }),
      inject('PATCH', `/api/incidents/${INC}/action-items/${A2}`, {
        expected_version: 1,
        status: 'done',
        actor: 'client-B',
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    // Final row is at version 2 (only one write applied).
    const { body } = await inject('GET', `/api/incidents/${INC}`);
    const a2 = body.action_items.find((a: { id: string }) => a.id === A2);
    expect(a2.version).toBe(2);
  });
});

describe('handoff sign-off is atomic and immutable', () => {
  async function createHandoff() {
    const { body } = await inject('POST', `/api/incidents/${INC}/handoffs`, {
      from_shift: '早班',
      to_shift: '晚班',
      summary: '交接摘要',
      created_by: '张三',
    });
    return body;
  }

  it('captures a frozen snapshot atomically at sign-off', async () => {
    const h = await createHandoff();
    const { status, body } = await inject(
      'POST',
      `/api/incidents/${INC}/handoffs/${h.id}/sign-off`,
      { signed_off_by: '王五', expected_version: 1 },
    );
    expect(status).toBe(200);
    expect(body.status).toBe('signed');
    expect(body.snapshot.incident.id).toBe(INC);
    expect(body.snapshot.action_items).toHaveLength(2);
    expect(body.snapshot.timeline_events).toHaveLength(2);
    expect(body.signed_off_by).toBe('王五');
  });

  it('does NOT auto-close unconfirmed / open action items on sign-off', async () => {
    const h = await createHandoff();
    await inject('POST', `/api/incidents/${INC}/handoffs/${h.id}/sign-off`, {
      signed_off_by: '王五',
      expected_version: 1,
    });
    const { body } = await inject('GET', `/api/incidents/${INC}`);
    const a2 = body.action_items.find((a: { id: string }) => a.id === A2);
    expect(a2.status).toBe('open'); // still open, sign-off did not touch it
  });

  it('freezes the snapshot: later changes do not alter a signed handoff', async () => {
    const h = await createHandoff();
    const signed = await inject('POST', `/api/incidents/${INC}/handoffs/${h.id}/sign-off`, {
      signed_off_by: '王五',
      expected_version: 1,
    });
    // Change an action item after sign-off.
    await inject('PATCH', `/api/incidents/${INC}/action-items/${A1}`, {
      expected_version: 1,
      status: 'done',
      actor: '后续班次',
    });
    const after = await inject('GET', `/api/handoffs/${h.id}`);
    const frozen = after.body.snapshot.action_items.find((a: { id: string }) => a.id === A1);
    expect(frozen.status).toBe('in_progress'); // snapshot value unchanged
    expect(signed.body.snapshot.action_items.find((a: { id: string }) => a.id === A1).status).toBe(
      'in_progress',
    );
  });

  it('is idempotent: a retried sign-off with the same key returns the same handoff and does not re-sign', async () => {
    const h = await createHandoff();
    const key = 'signoff-key-123';
    const first = await inject(
      'POST',
      `/api/incidents/${INC}/handoffs/${h.id}/sign-off`,
      { signed_off_by: '王五', expected_version: 1 },
      { 'idempotency-key': key },
    );
    const retry = await inject(
      'POST',
      `/api/incidents/${INC}/handoffs/${h.id}/sign-off`,
      { signed_off_by: '王五', expected_version: 1 },
      { 'idempotency-key': key },
    );
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.signed_off_at).toBe(first.body.signed_off_at);
    expect(retry.body.version).toBe(first.body.version);
  });

  it('a duplicate sign-off without a key still does not change the frozen view', async () => {
    const h = await createHandoff();
    const first = await inject('POST', `/api/incidents/${INC}/handoffs/${h.id}/sign-off`, {
      signed_off_by: '王五',
      expected_version: 1,
    });
    // Late/duplicate request with a now-stale expected_version.
    const dup = await inject('POST', `/api/incidents/${INC}/handoffs/${h.id}/sign-off`, {
      signed_off_by: '别人',
      expected_version: 1,
    });
    expect(dup.status).toBe(200);
    expect(dup.body.signed_off_by).toBe('王五'); // unchanged
    expect(dup.body.signed_off_at).toBe(first.body.signed_off_at);
  });

  it('only one of two concurrent sign-offs performs the transition', async () => {
    const h = await createHandoff();
    const [r1, r2] = await Promise.all([
      inject('POST', `/api/incidents/${INC}/handoffs/${h.id}/sign-off`, {
        signed_off_by: 'A',
        expected_version: 1,
      }),
      inject('POST', `/api/incidents/${INC}/handoffs/${h.id}/sign-off`, {
        signed_off_by: 'B',
        expected_version: 1,
      }),
    ]);
    // Both succeed as 200 but converge to a single signer.
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.signed_off_by).toBe(r2.body.signed_off_by);
    expect(r1.body.version).toBe(r2.body.version);
  });
});

describe('per-item acknowledgements are idempotent', () => {
  async function signedHandoff() {
    const { body: h } = await inject('POST', `/api/incidents/${INC}/handoffs`, {
      from_shift: '早班',
      to_shift: '晚班',
      summary: 's',
      created_by: '张三',
    });
    await inject('POST', `/api/incidents/${INC}/handoffs/${h.id}/sign-off`, {
      signed_off_by: '王五',
      expected_version: 1,
    });
    return h.id as string;
  }

  it('creates one acknowledgement then treats retries as duplicates', async () => {
    const hid = await signedHandoff();
    const first = await inject('POST', `/api/handoffs/${hid}/acknowledgements`, {
      item_type: 'action_item',
      item_id: A1,
      acknowledged_by: '接班人',
    });
    expect(first.status).toBe(201);
    expect(first.body.duplicate).toBe(false);

    const retry = await inject('POST', `/api/handoffs/${hid}/acknowledgements`, {
      item_type: 'action_item',
      item_id: A1,
      acknowledged_by: '接班人',
    });
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    expect(retry.body.id).toBe(first.body.id);
  });

  it('does not create a second confirmation under concurrent duplicate submits', async () => {
    const hid = await signedHandoff();
    const payload = { item_type: 'action_item', item_id: A2, acknowledged_by: '接班人' };
    const results = await Promise.all([
      inject('POST', `/api/handoffs/${hid}/acknowledgements`, payload),
      inject('POST', `/api/handoffs/${hid}/acknowledgements`, payload),
      inject('POST', `/api/handoffs/${hid}/acknowledgements`, payload),
    ]);
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1); // all point at the same acknowledgement
    const detail = await inject('GET', `/api/handoffs/${hid}`);
    const acksForA2 = detail.body.acknowledgements.filter(
      (a: { item_id: string }) => a.item_id === A2,
    );
    expect(acksForA2).toHaveLength(1);
  });

  it('an idempotency key collapses retries to a single acknowledgement', async () => {
    const hid = await signedHandoff();
    const key = 'ack-key-xyz';
    const a = await inject(
      'POST',
      `/api/handoffs/${hid}/acknowledgements`,
      { item_type: 'timeline_event', item_id: 'tl-gd-20260729-01-e1', acknowledged_by: '接班人' },
      { 'idempotency-key': key },
    );
    const b = await inject(
      'POST',
      `/api/handoffs/${hid}/acknowledgements`,
      { item_type: 'timeline_event', item_id: 'tl-gd-20260729-01-e1', acknowledged_by: '接班人' },
      { 'idempotency-key': key },
    );
    expect(a.body.id).toBe(b.body.id);
    expect(b.body.duplicate).toBe(true);
  });
});

describe('supplemental events after sign-off', () => {
  it('rejects supplemental events on a draft handoff', async () => {
    const { body: h } = await inject('POST', `/api/incidents/${INC}/handoffs`, {
      from_shift: '早',
      to_shift: '晚',
      summary: 's',
      created_by: 'x',
    });
    const { status } = await inject(
      'POST',
      `/api/incidents/${INC}/handoffs/${h.id}/supplemental`,
      { kind: 'update', description: '新变化', responsible_party: '现场组', occurred_at: '2026-07-29T06:00:00.000Z' },
    );
    expect(status).toBe(400);
  });

  it('appends a supplemental event linked to the original signed handoff', async () => {
    const { body: h } = await inject('POST', `/api/incidents/${INC}/handoffs`, {
      from_shift: '早',
      to_shift: '晚',
      summary: 's',
      created_by: 'x',
    });
    await inject('POST', `/api/incidents/${INC}/handoffs/${h.id}/sign-off`, {
      signed_off_by: '王五',
      expected_version: 1,
    });
    const { status, body } = await inject(
      'POST',
      `/api/incidents/${INC}/handoffs/${h.id}/supplemental`,
      { kind: 'update', description: '签收后水位继续上涨', responsible_party: '现场组', occurred_at: '2026-07-29T06:00:00.000Z' },
    );
    expect(status).toBe(201);
    expect(body.parent_handoff_id).toBe(h.id); // explicitly linked to the origin
    const detail = await inject('GET', `/api/handoffs/${h.id}`);
    expect(detail.body.supplemental_events).toHaveLength(1);
  });
});

describe('audit trail', () => {
  it('records handoff.signed and item.acknowledged events', async () => {
    const { body: h } = await inject('POST', `/api/incidents/${INC}/handoffs`, {
      from_shift: '早',
      to_shift: '晚',
      summary: 's',
      created_by: 'x',
    });
    await inject('POST', `/api/incidents/${INC}/handoffs/${h.id}/sign-off`, {
      signed_off_by: '王五',
      expected_version: 1,
    });
    await inject('POST', `/api/handoffs/${h.id}/acknowledgements`, {
      item_type: 'action_item',
      item_id: A1,
      acknowledged_by: '接班人',
    });
    const { rows } = await (await import('../src/db.js')).pool.query(
      "SELECT event_type FROM audit_events WHERE handoff_id = $1 ORDER BY id",
      [h.id],
    );
    const types = rows.map((r: { event_type: string }) => r.event_type);
    expect(types).toContain('handoff.created');
    expect(types).toContain('handoff.signed');
    expect(types).toContain('item.acknowledged');
  });
});
