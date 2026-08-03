import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, ensureSchema, resetData } from './helpers.js';
import { pool } from '../src/db.js';

const INC = 'inc-gd-20260729-01';
const A1 = 'act-gd-20260729-01-a1';

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

/** Create + sign a parent handoff, returning its id. */
async function signedParent(): Promise<string> {
  const { body: h } = await inject('POST', `/api/incidents/${INC}/handoffs`, {
    from_shift: '早班',
    to_shift: '晚班',
    summary: '父交接',
    created_by: '张三',
  });
  const signed = await inject('POST', `/api/incidents/${INC}/handoffs/${h.id}/sign-off`, {
    signed_off_by: '王五',
    expected_version: 1,
  });
  expect(signed.status).toBe(200);
  return h.id as string;
}

describe('supplemental handoff package', () => {
  it('rejects creation against a draft (unsigned) handoff', async () => {
    const { body: h } = await inject('POST', `/api/incidents/${INC}/handoffs`, {
      from_shift: '早',
      to_shift: '晚',
      summary: 's',
      created_by: 'x',
    });
    const res = await inject('POST', `/api/incidents/${INC}/handoffs/${h.id}/supplemental-handoff`, {
      from_shift: '晚班',
      to_shift: '夜班',
      created_by: '晚班负责人',
    });
    expect(res.status).toBe(400);
  });

  it('captures only additions and field-level changes since the parent snapshot', async () => {
    const parentId = await signedParent();

    // After sign-off: add a new timeline event ev-...-03 and a new action item
    // ai-...-03, and change an existing action item's status.
    await inject('POST', `/api/incidents/${INC}/timeline`, {
      id: 'ev-gd-20260729-03',
      kind: 'road_reopen',
      description: '东侧绕行路线重新开放。',
      responsible_party: '交通协调组',
      occurred_at: '2026-07-29T06:00:00.000Z',
      actor: '交通协调组',
    });
    await inject('POST', `/api/incidents/${INC}/action-items`, {
      id: 'ai-gd-20260729-03',
      title: '复核重新开放后的通行能力',
      status: 'open',
      responsible_party: '交通协调组',
      occurred_at: '2026-07-29T06:05:00.000Z',
      actor: '交通协调组',
    });
    // Change an existing item (in the parent snapshot) from in_progress -> done.
    await inject('PATCH', `/api/incidents/${INC}/action-items/${A1}`, {
      expected_version: 1,
      status: 'done',
      actor: '交通协调组',
    });

    const res = await inject(
      'POST',
      `/api/incidents/${INC}/handoffs/${parentId}/supplemental-handoff`,
      { from_shift: '晚班', to_shift: '夜班', summary: '绕行路线已开放', created_by: '晚班负责人' },
    );
    expect(res.status).toBe(201);
    expect(res.body.parent_handoff_id).toBe(parentId);

    const diff = res.body.diff;
    // The new timeline event and action item are captured as additions.
    expect(diff.added_timeline_events.map((e: { id: string }) => e.id)).toContain('ev-gd-20260729-03');
    expect(diff.added_action_items.map((a: { id: string }) => a.id)).toContain('ai-gd-20260729-03');

    // The changed existing item is captured with a per-field from/to change.
    const changed = diff.changed_action_items.find((c: { id: string }) => c.id === A1);
    expect(changed).toBeTruthy();
    const statusChange = changed.changes.find((c: { field: string }) => c.field === 'status');
    expect(statusChange).toEqual({ field: 'status', from: 'in_progress', to: 'done' });

    // Items that did not change are NOT included (pure delta).
    expect(diff.changed_timeline_events).toHaveLength(0);
  });

  it('leaves the parent handoff snapshot, status, version and acknowledgements unchanged', async () => {
    const parentId = await signedParent();
    // Acknowledge an item on the parent before supplementing.
    await inject('POST', `/api/handoffs/${parentId}/acknowledgements`, {
      item_type: 'action_item',
      item_id: A1,
      acknowledged_by: '接班人',
    });
    const before = await inject('GET', `/api/handoffs/${parentId}`);

    // Change live state, then build a supplemental package.
    await inject('PATCH', `/api/incidents/${INC}/action-items/${A1}`, {
      expected_version: 1,
      status: 'done',
      actor: '晚班',
    });
    await inject('POST', `/api/incidents/${INC}/handoffs/${parentId}/supplemental-handoff`, {
      from_shift: '晚班',
      to_shift: '夜班',
      created_by: '晚班负责人',
    });

    const after = await inject('GET', `/api/handoffs/${parentId}`);
    // Parent stays frozen: status, version, signer, snapshot, acks all identical.
    expect(after.body.status).toBe('signed');
    expect(after.body.version).toBe(before.body.version);
    expect(after.body.signed_off_by).toBe(before.body.signed_off_by);
    expect(after.body.acknowledgements).toHaveLength(before.body.acknowledgements.length);
    const frozen = after.body.snapshot.action_items.find((a: { id: string }) => a.id === A1);
    expect(frozen.status).toBe('in_progress'); // snapshot value unchanged
  });

  it('produces exactly one package, one diff and one audit event under concurrent creates', async () => {
    const parentId = await signedParent();
    await inject('POST', `/api/incidents/${INC}/action-items`, {
      id: 'ai-gd-20260729-03',
      title: '后续项',
      responsible_party: '晚班',
      occurred_at: '2026-07-29T06:05:00.000Z',
      actor: '晚班',
    });

    const payload = { from_shift: '晚班', to_shift: '夜班', created_by: '晚班负责人' };
    const [r1, r2, r3] = await Promise.all([
      inject('POST', `/api/incidents/${INC}/handoffs/${parentId}/supplemental-handoff`, payload),
      inject('POST', `/api/incidents/${INC}/handoffs/${parentId}/supplemental-handoff`, payload),
      inject('POST', `/api/incidents/${INC}/handoffs/${parentId}/supplemental-handoff`, payload),
    ]);
    const ids = new Set([r1.body.id, r2.body.id, r3.body.id]);
    expect(ids.size).toBe(1); // one package

    const packages = await pool.query(
      'SELECT id FROM supplemental_handoffs WHERE parent_handoff_id = $1',
      [parentId],
    );
    expect(packages.rows).toHaveLength(1);

    const audits = await pool.query(
      "SELECT id FROM audit_events WHERE handoff_id = $1 AND event_type = 'handoff.supplemental_package_created'",
      [parentId],
    );
    expect(audits.rows).toHaveLength(1); // one audit event
  });

  it('is idempotent: retry with the same key returns the same package, no second audit event', async () => {
    const parentId = await signedParent();
    const key = 'supp-pkg-key-1';
    const payload = { from_shift: '晚班', to_shift: '夜班', created_by: '晚班负责人' };

    const first = await inject(
      'POST',
      `/api/incidents/${INC}/handoffs/${parentId}/supplemental-handoff`,
      payload,
      { 'idempotency-key': key },
    );
    const retry = await inject(
      'POST',
      `/api/incidents/${INC}/handoffs/${parentId}/supplemental-handoff`,
      payload,
      { 'idempotency-key': key },
    );
    expect(first.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);

    const audits = await pool.query(
      "SELECT id FROM audit_events WHERE handoff_id = $1 AND event_type = 'handoff.supplemental_package_created'",
      [parentId],
    );
    expect(audits.rows).toHaveLength(1);
  });

  it('surfaces the supplemental package on the incident bundle and handoff detail', async () => {
    const parentId = await signedParent();
    await inject('POST', `/api/incidents/${INC}/handoffs/${parentId}/supplemental-handoff`, {
      from_shift: '晚班',
      to_shift: '夜班',
      created_by: '晚班负责人',
    });

    const detail = await inject('GET', `/api/handoffs/${parentId}`);
    expect(detail.body.supplemental_handoff).toBeTruthy();
    expect(detail.body.supplemental_handoff.parent_handoff_id).toBe(parentId);

    const bundle = await inject('GET', `/api/incidents/${INC}`);
    const parent = bundle.body.handoffs.find((h: { id: string }) => h.id === parentId);
    expect(parent.supplemental_handoff).toBeTruthy();
  });
});
