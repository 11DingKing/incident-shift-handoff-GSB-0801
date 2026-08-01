import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, ensureSchema, resetData } from './helpers.js';
import { pool } from '../src/db.js';

const INC = 'inc-gd-20260729-01';
const AI3 = 'ai-gd-20260729-03';

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

/**
 * Sign a parent handoff, add a post-sign-off action item ai-gd-20260729-03,
 * then build a supplemental package. Returns { parentId, suppId }.
 */
async function setupSupplemental(): Promise<{ parentId: string; suppId: string }> {
  const { body: h } = await inject('POST', `/api/incidents/${INC}/handoffs`, {
    from_shift: '早班',
    to_shift: '晚班',
    summary: '父交接',
    created_by: '张三',
  });
  await inject('POST', `/api/incidents/${INC}/handoffs/${h.id}/sign-off`, {
    signed_off_by: '王五',
    expected_version: 1,
  });
  await inject('POST', `/api/incidents/${INC}/action-items`, {
    id: AI3,
    title: '复核重新开放后的通行能力',
    status: 'open',
    responsible_party: '交通协调组',
    occurred_at: '2026-07-29T06:05:00.000Z',
    actor: '交通协调组',
  });
  const { body: pkg } = await inject(
    'POST',
    `/api/incidents/${INC}/handoffs/${h.id}/supplemental-handoff`,
    { from_shift: '晚班', to_shift: '夜班', created_by: '晚班负责人' },
  );
  return { parentId: h.id as string, suppId: pkg.id as string };
}

function ackUrl(suppId: string): string {
  return `/api/supplemental-handoffs/${suppId}/acknowledgements`;
}

describe('supplemental-package acknowledgement concurrency', () => {
  it('confirms a supplemental action item with the current version', async () => {
    const { parentId, suppId } = await setupSupplemental();
    const res = await inject('POST', ackUrl(suppId), {
      parent_handoff_id: parentId,
      item_type: 'action_item',
      item_id: AI3,
      acknowledged_by: '夜班',
      expected_version: 1,
    });
    expect(res.status).toBe(201);
    expect(res.body.duplicate).toBe(false);
    expect(res.body.supplemental_handoff_id).toBe(suppId);
    expect(res.body.acked_version).toBe(1);
  });

  it('rejects a confirmation carrying a stale version with a field-level conflict and writes no ack', async () => {
    const { parentId, suppId } = await setupSupplemental();
    // Someone updates ai-gd-20260729-03 to v2 out-of-band.
    await inject('PATCH', `/api/incidents/${INC}/action-items/${AI3}`, {
      expected_version: 1,
      status: 'in_progress',
      actor: '现场组',
    });

    // A confirmer using the pre-update version 1 must be rejected.
    const res = await inject('POST', ackUrl(suppId), {
      parent_handoff_id: parentId,
      item_type: 'action_item',
      item_id: AI3,
      acknowledged_by: '夜班',
      expected_version: 1,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('version_conflict');
    expect(res.body.actual_version).toBe(2);
    // Field-level current values are present.
    expect(res.body.conflicts.status).toEqual({ current: 'in_progress' });
    expect(res.body.current.status).toBe('in_progress');

    // No acknowledgement was written by the rejected attempt.
    const acks = await pool.query(
      'SELECT * FROM acknowledgements WHERE supplemental_handoff_id = $1 AND item_id = $2',
      [suppId, AI3],
    );
    expect(acks.rows).toHaveLength(0);
  });

  it('two concurrent confirmers (one stale, one current) yield exactly one valid ack', async () => {
    const { parentId, suppId } = await setupSupplemental();
    // Bump the item to v2 so version 1 is stale.
    await inject('PATCH', `/api/incidents/${INC}/action-items/${AI3}`, {
      expected_version: 1,
      status: 'in_progress',
      actor: '现场组',
    });

    const [stale, fresh] = await Promise.all([
      inject('POST', ackUrl(suppId), {
        parent_handoff_id: parentId,
        item_type: 'action_item',
        item_id: AI3,
        acknowledged_by: '会话A(旧版本)',
        expected_version: 1,
      }),
      inject('POST', ackUrl(suppId), {
        parent_handoff_id: parentId,
        item_type: 'action_item',
        item_id: AI3,
        acknowledged_by: '会话B(新版本)',
        expected_version: 2,
      }),
    ]);
    const statuses = [stale.status, fresh.status].sort();
    expect(statuses).toEqual([201, 409]);

    // Exactly one acknowledgement exists, at the fresh version.
    const acks = await pool.query(
      'SELECT * FROM acknowledgements WHERE supplemental_handoff_id = $1 AND item_id = $2',
      [suppId, AI3],
    );
    expect(acks.rows).toHaveLength(1);
    expect(acks.rows[0].acked_version).toBe(2);
  });

  it('a disconnected retry with the same idempotency key does not add a second ack', async () => {
    const { parentId, suppId } = await setupSupplemental();
    const key = 'supp-ack-retry-1';
    const payload = {
      parent_handoff_id: parentId,
      item_type: 'action_item',
      item_id: AI3,
      acknowledged_by: '夜班',
      expected_version: 1,
    };
    const first = await inject('POST', ackUrl(suppId), payload, { 'idempotency-key': key });
    const retry = await inject('POST', ackUrl(suppId), payload, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.duplicate).toBe(true);

    const acks = await pool.query(
      'SELECT * FROM acknowledgements WHERE supplemental_handoff_id = $1 AND item_id = $2',
      [suppId, AI3],
    );
    expect(acks.rows).toHaveLength(1);
  });

  it('does not add a parent-scope ack or auto-close the action item on supplemental confirmation', async () => {
    const { parentId, suppId } = await setupSupplemental();
    await inject('POST', ackUrl(suppId), {
      parent_handoff_id: parentId,
      item_type: 'action_item',
      item_id: AI3,
      acknowledged_by: '夜班',
      expected_version: 1,
    });

    // Parent handoff has NO acknowledgement for ai-gd-20260729-03 (different scope).
    const parentDetail = await inject('GET', `/api/handoffs/${parentId}`);
    const parentAcks = parentDetail.body.acknowledgements.filter(
      (a: { item_id: string }) => a.item_id === AI3,
    );
    expect(parentAcks).toHaveLength(0);
    // The supplemental package carries exactly the one ack.
    expect(parentDetail.body.supplemental_handoff.acknowledgements).toHaveLength(1);

    // The action item itself is NOT auto-closed by acknowledgement.
    const bundle = await inject('GET', `/api/incidents/${INC}`);
    const item = bundle.body.action_items.find((a: { id: string }) => a.id === AI3);
    expect(item.status).toBe('open');
  });

  it('confirming in the supplemental scope is independent of a parent-scope confirmation of the same item', async () => {
    const { parentId, suppId } = await setupSupplemental();
    // Confirm at parent scope first (no version check needed there).
    const parent = await inject('POST', `/api/handoffs/${parentId}/acknowledgements`, {
      item_type: 'action_item',
      item_id: AI3,
      acknowledged_by: '接班人',
    });
    expect(parent.status).toBe(201);
    // Then confirm the same item at supplemental scope: allowed, separate ack.
    const supp = await inject('POST', ackUrl(suppId), {
      parent_handoff_id: parentId,
      item_type: 'action_item',
      item_id: AI3,
      acknowledged_by: '夜班',
      expected_version: 1,
    });
    expect(supp.status).toBe(201);
    expect(supp.body.id).not.toBe(parent.body.id);

    const acks = await pool.query(
      'SELECT * FROM acknowledgements WHERE item_id = $1 ORDER BY supplemental_handoff_id NULLS FIRST',
      [AI3],
    );
    expect(acks.rows).toHaveLength(2);
  });
});
