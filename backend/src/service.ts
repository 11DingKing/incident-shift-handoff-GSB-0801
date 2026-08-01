import type pg from 'pg';
import { pool, withTransaction, type QueryRunner } from './db.js';
import { genId } from './ids.js';
import { ConflictError, ImmutableError, NotFoundError, ValidationError } from './errors.js';
import type {
  ActionItem,
  ActionItemStatus,
  Acknowledgement,
  ConflictBody,
  Handoff,
  HandoffSnapshot,
  Incident,
  SupplementalEvent,
  TimelineEvent,
} from './types.js';

const ACTION_ITEM_STATUSES: ActionItemStatus[] = ['open', 'in_progress', 'blocked', 'done'];

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getIncident(id: string, runner: QueryRunner = pool): Promise<Incident> {
  const { rows } = await runner.query<Incident>('SELECT * FROM incidents WHERE id = $1', [id]);
  if (rows.length === 0) throw new NotFoundError('incident', id);
  return rows[0]!;
}

export async function listActionItems(
  incidentId: string,
  runner: QueryRunner = pool,
): Promise<ActionItem[]> {
  const { rows } = await runner.query<ActionItem>(
    'SELECT * FROM action_items WHERE incident_id = $1 ORDER BY occurred_at, id',
    [incidentId],
  );
  return rows;
}

export async function listTimelineEvents(
  incidentId: string,
  runner: QueryRunner = pool,
): Promise<TimelineEvent[]> {
  const { rows } = await runner.query<TimelineEvent>(
    'SELECT * FROM timeline_events WHERE incident_id = $1 ORDER BY occurred_at, id',
    [incidentId],
  );
  return rows;
}

export async function listHandoffs(
  incidentId: string,
  runner: QueryRunner = pool,
): Promise<Handoff[]> {
  const { rows } = await runner.query<Handoff>(
    'SELECT * FROM handoffs WHERE incident_id = $1 ORDER BY created_at, id',
    [incidentId],
  );
  return rows;
}

export async function getHandoff(id: string, runner: QueryRunner = pool): Promise<Handoff> {
  const { rows } = await runner.query<Handoff>('SELECT * FROM handoffs WHERE id = $1', [id]);
  if (rows.length === 0) throw new NotFoundError('handoff', id);
  return rows[0]!;
}

export async function listAcknowledgements(
  handoffId: string,
  runner: QueryRunner = pool,
): Promise<Acknowledgement[]> {
  const { rows } = await runner.query<Acknowledgement>(
    'SELECT * FROM acknowledgements WHERE handoff_id = $1 ORDER BY acknowledged_at, id',
    [handoffId],
  );
  return rows;
}

export async function listSupplementalEvents(
  handoffId: string,
  runner: QueryRunner = pool,
): Promise<SupplementalEvent[]> {
  const { rows } = await runner.query<SupplementalEvent>(
    'SELECT * FROM supplemental_events WHERE parent_handoff_id = $1 ORDER BY occurred_at, id',
    [handoffId],
  );
  return rows;
}

/** Full aggregate for the incident view. */
export async function getIncidentBundle(incidentId: string) {
  const incident = await getIncident(incidentId);
  const [actionItems, timeline, handoffs] = await Promise.all([
    listActionItems(incidentId),
    listTimelineEvents(incidentId),
    listHandoffs(incidentId),
  ]);
  const handoffDetails = await Promise.all(
    handoffs.map(async (h) => ({
      ...h,
      acknowledgements: await listAcknowledgements(h.id),
      supplemental_events: await listSupplementalEvents(h.id),
    })),
  );
  return { incident, action_items: actionItems, timeline_events: timeline, handoffs: handoffDetails };
}

// ---------------------------------------------------------------------------
// Optimistic-locked action item update (field-level conflict)
// ---------------------------------------------------------------------------

export interface UpdateActionItemInput {
  expectedVersion: number;
  status?: ActionItemStatus;
  title?: string;
  detail?: string;
  responsible_party?: string;
  actor: string;
}

function buildConflict(
  entity: string,
  id: string,
  expectedVersion: number,
  current: Record<string, unknown>,
  attempted: Record<string, unknown>,
): ConflictBody {
  // Report every field the caller attempted to change so the UI can render a
  // precise field-level conflict rather than silently overwriting.
  const conflicts: Record<string, { current: unknown }> = {};
  for (const key of Object.keys(attempted)) {
    if (attempted[key] !== undefined && current[key] !== attempted[key]) {
      conflicts[key] = { current: current[key] };
    }
  }
  return {
    error: 'version_conflict',
    message: `${entity} ${id} was modified by someone else (expected v${expectedVersion}, now v${current.version}).`,
    entity,
    id,
    expected_version: expectedVersion,
    actual_version: current.version as number,
    conflicts,
    current,
  };
}

export async function updateActionItem(
  incidentId: string,
  itemId: string,
  input: UpdateActionItemInput,
): Promise<ActionItem> {
  if (input.status && !ACTION_ITEM_STATUSES.includes(input.status)) {
    throw new ValidationError(`invalid status: ${input.status}`);
  }
  return withTransaction(async (client) => {
    // Lock the row so two concurrent updaters serialize here.
    const { rows } = await client.query<ActionItem>(
      'SELECT * FROM action_items WHERE id = $1 AND incident_id = $2 FOR UPDATE',
      [itemId, incidentId],
    );
    if (rows.length === 0) throw new NotFoundError('action_item', itemId);
    const current = rows[0]!;

    if (current.version !== input.expectedVersion) {
      const attempted = {
        status: input.status,
        title: input.title,
        detail: input.detail,
        responsible_party: input.responsible_party,
      };
      throw new ConflictError(
        buildConflict('action_item', itemId, input.expectedVersion, current as never, attempted),
      );
    }

    const next = {
      status: input.status ?? current.status,
      title: input.title ?? current.title,
      detail: input.detail ?? current.detail,
      responsible_party: input.responsible_party ?? current.responsible_party,
    };
    const { rows: updated } = await client.query<ActionItem>(
      `UPDATE action_items
         SET status = $1, title = $2, detail = $3, responsible_party = $4,
             version = version + 1, updated_at = now()
       WHERE id = $5 AND version = $6
       RETURNING *`,
      [next.status, next.title, next.detail, next.responsible_party, itemId, input.expectedVersion],
    );
    const result = updated[0]!;
    await writeAudit(client, {
      incidentId,
      handoffId: null,
      eventType: 'action_item.updated',
      actor: input.actor,
      payload: { item_id: itemId, from: current, to: result },
    });
    return result;
  });
}

// ---------------------------------------------------------------------------
// Timeline events (append-only) and supplemental events
// ---------------------------------------------------------------------------

export interface AddTimelineInput {
  kind: string;
  description: string;
  responsible_party: string;
  evidence_uri?: string | null;
  occurred_at: string;
  actor: string;
}

export async function addTimelineEvent(
  incidentId: string,
  input: AddTimelineInput,
): Promise<TimelineEvent> {
  return withTransaction(async (client) => {
    await getIncident(incidentId, client); // 404 if missing
    const id = genId('tl');
    const { rows } = await client.query<TimelineEvent>(
      `INSERT INTO timeline_events
         (id, incident_id, kind, description, responsible_party, evidence_uri, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        incidentId,
        input.kind,
        input.description,
        input.responsible_party,
        input.evidence_uri ?? null,
        input.occurred_at,
      ],
    );
    const event = rows[0]!;
    await writeAudit(client, {
      incidentId,
      handoffId: null,
      eventType: 'timeline.appended',
      actor: input.actor,
      payload: { timeline_event_id: id },
    });
    return event;
  });
}

// ---------------------------------------------------------------------------
// Handoffs: create draft, sign off (atomic snapshot), append supplemental
// ---------------------------------------------------------------------------

export interface CreateHandoffInput {
  from_shift: string;
  to_shift: string;
  summary: string;
  created_by: string;
}

export async function createHandoff(
  incidentId: string,
  input: CreateHandoffInput,
): Promise<Handoff> {
  return withTransaction(async (client) => {
    await getIncident(incidentId, client);
    const id = genId('ho');
    const { rows } = await client.query<Handoff>(
      `INSERT INTO handoffs (id, incident_id, from_shift, to_shift, summary, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6)
       RETURNING *`,
      [id, incidentId, input.from_shift, input.to_shift, input.summary, input.created_by],
    );
    const handoff = rows[0]!;
    await writeAudit(client, {
      incidentId,
      handoffId: id,
      eventType: 'handoff.created',
      actor: input.created_by,
      payload: { handoff_id: id },
    });
    return handoff;
  });
}

export interface SignOffInput {
  signed_off_by: string;
  expectedVersion: number;
  idempotencyKey?: string;
  actor: string;
}

/**
 * Signs off a handoff. The frozen snapshot (incident + action items + timeline),
 * the sign-off timeline/audit event and the status transition are all produced
 * inside ONE transaction, so the archived view can never be partially written.
 *
 * Idempotent: a retried request carrying the same idempotency key returns the
 * originally stored handoff instead of erroring or double-signing.
 *
 * Immutable: signing a handoff that is already signed short-circuits to the
 * stored result (safe retry) rather than mutating the frozen snapshot.
 *
 * Sign-off NEVER auto-closes unacknowledged / open action items.
 */
export async function signOffHandoff(
  incidentId: string,
  handoffId: string,
  input: SignOffInput,
): Promise<Handoff> {
  return withTransaction(async (client) => {
    if (input.idempotencyKey) {
      const replayed = await replayIdempotent<Handoff>(client, input.idempotencyKey, 'sign_off');
      if (replayed) return replayed;
    }

    const { rows } = await client.query<Handoff>(
      'SELECT * FROM handoffs WHERE id = $1 AND incident_id = $2 FOR UPDATE',
      [handoffId, incidentId],
    );
    if (rows.length === 0) throw new NotFoundError('handoff', handoffId);
    const handoff = rows[0]!;

    // Already signed: a duplicate/late request must not change the frozen view.
    if (handoff.status === 'signed') {
      if (input.idempotencyKey) {
        await storeIdempotent(client, input.idempotencyKey, 'sign_off', handoff);
      }
      return handoff;
    }

    if (handoff.version !== input.expectedVersion) {
      throw new ConflictError(
        buildConflict('handoff', handoffId, input.expectedVersion, handoff as never, {
          status: 'signed',
        }),
      );
    }

    // Build the frozen snapshot from the live aggregate.
    const incident = await getIncident(incidentId, client);
    const actionItems = await listActionItems(incidentId, client);
    const timeline = await listTimelineEvents(incidentId, client);
    const snapshot: HandoffSnapshot = {
      incident,
      action_items: actionItems,
      timeline_events: timeline,
      captured_at: new Date().toISOString(),
    };

    const { rows: signed } = await client.query<Handoff>(
      `UPDATE handoffs
         SET status = 'signed', snapshot = $1, signed_off_by = $2,
             signed_off_at = now(), version = version + 1
       WHERE id = $3 AND version = $4
       RETURNING *`,
      [JSON.stringify(snapshot), input.signed_off_by, handoffId, input.expectedVersion],
    );
    const result = signed[0]!;

    // Audit event, produced in the SAME transaction as the snapshot.
    await writeAudit(client, {
      incidentId,
      handoffId,
      eventType: 'handoff.signed',
      actor: input.actor,
      payload: {
        handoff_id: handoffId,
        open_action_items: actionItems.filter((a) => a.status !== 'done').map((a) => a.id),
      },
    });

    if (input.idempotencyKey) {
      await storeIdempotent(client, input.idempotencyKey, 'sign_off', result);
    }
    return result;
  });
}

export interface AddSupplementalInput {
  kind: string;
  description: string;
  responsible_party: string;
  occurred_at: string;
  actor: string;
  idempotencyKey?: string;
}

/**
 * Appends a supplemental event to a SIGNED handoff. This is the only legal way
 * to record change after sign-off; it never mutates the frozen handoff.
 */
export async function addSupplementalEvent(
  incidentId: string,
  handoffId: string,
  input: AddSupplementalInput,
): Promise<SupplementalEvent> {
  return withTransaction(async (client) => {
    if (input.idempotencyKey) {
      const replayed = await replayIdempotent<SupplementalEvent>(
        client,
        input.idempotencyKey,
        'supplemental',
      );
      if (replayed) return replayed;
    }

    const { rows } = await client.query<Handoff>(
      'SELECT * FROM handoffs WHERE id = $1 AND incident_id = $2',
      [handoffId, incidentId],
    );
    if (rows.length === 0) throw new NotFoundError('handoff', handoffId);
    const handoff = rows[0]!;
    if (handoff.status !== 'signed') {
      throw new ValidationError(
        'supplemental events can only be attached to a signed handoff; edit the draft instead',
      );
    }

    const id = genId('sup');
    const { rows: created } = await client.query<SupplementalEvent>(
      `INSERT INTO supplemental_events
         (id, incident_id, parent_handoff_id, kind, description, responsible_party, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        incidentId,
        handoffId,
        input.kind,
        input.description,
        input.responsible_party,
        input.occurred_at,
      ],
    );
    const event = created[0]!;
    await writeAudit(client, {
      incidentId,
      handoffId,
      eventType: 'handoff.supplemented',
      actor: input.actor,
      payload: { supplemental_event_id: id, parent_handoff_id: handoffId },
    });

    if (input.idempotencyKey) {
      await storeIdempotent(client, input.idempotencyKey, 'supplemental', event);
    }
    return event;
  });
}

// ---------------------------------------------------------------------------
// Per-item acknowledgements (idempotent, one per item per handoff)
// ---------------------------------------------------------------------------

export interface AcknowledgeInput {
  item_type: 'action_item' | 'timeline_event';
  item_id: string;
  acknowledged_by: string;
  note?: string;
  idempotencyKey?: string;
}

export async function acknowledgeItem(
  handoffId: string,
  input: AcknowledgeInput,
): Promise<{ acknowledgement: Acknowledgement; duplicate: boolean }> {
  return withTransaction(async (client) => {
    if (input.idempotencyKey) {
      const replayed = await replayIdempotent<Acknowledgement>(
        client,
        input.idempotencyKey,
        'acknowledge',
      );
      if (replayed) return { acknowledgement: replayed, duplicate: true };
    }

    const { rows: handoffRows } = await client.query<Handoff>(
      'SELECT * FROM handoffs WHERE id = $1',
      [handoffId],
    );
    if (handoffRows.length === 0) throw new NotFoundError('handoff', handoffId);

    // Enforce one acknowledgement per (handoff, item). A concurrent duplicate
    // loses the unique-index race and is returned the existing row instead of a
    // second confirmation.
    const existing = await client.query<Acknowledgement>(
      `SELECT * FROM acknowledgements
       WHERE handoff_id = $1 AND item_type = $2 AND item_id = $3`,
      [handoffId, input.item_type, input.item_id],
    );
    if (existing.rows.length > 0) {
      const ack = existing.rows[0]!;
      if (input.idempotencyKey) {
        await storeIdempotent(client, input.idempotencyKey, 'acknowledge', ack);
      }
      return { acknowledgement: ack, duplicate: true };
    }

    const id = genId('ack');
    // INSERT ... ON CONFLICT DO NOTHING keeps the transaction valid even when a
    // concurrent duplicate already inserted the row. If nothing is returned we
    // lost the race and read back the winning acknowledgement.
    const inserted = await client.query<Acknowledgement>(
      `INSERT INTO acknowledgements
         (id, handoff_id, item_type, item_id, acknowledged_by, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (handoff_id, item_type, item_id) DO NOTHING
       RETURNING *`,
      [id, handoffId, input.item_type, input.item_id, input.acknowledged_by, input.note ?? ''],
    );

    if (inserted.rows.length === 0) {
      const { rows } = await client.query<Acknowledgement>(
        `SELECT * FROM acknowledgements
         WHERE handoff_id = $1 AND item_type = $2 AND item_id = $3`,
        [handoffId, input.item_type, input.item_id],
      );
      const winner = rows[0]!;
      if (input.idempotencyKey) {
        await storeIdempotent(client, input.idempotencyKey, 'acknowledge', winner);
      }
      return { acknowledgement: winner, duplicate: true };
    }
    const ack = inserted.rows[0]!;

    await writeAudit(client, {
      incidentId: handoffRows[0]!.incident_id,
      handoffId,
      eventType: 'item.acknowledged',
      actor: input.acknowledged_by,
      payload: { item_type: input.item_type, item_id: input.item_id, ack_id: id },
    });

    if (input.idempotencyKey) {
      await storeIdempotent(client, input.idempotencyKey, 'acknowledge', ack);
    }
    return { acknowledgement: ack, duplicate: false };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AuditInput {
  incidentId: string | null;
  handoffId: string | null;
  eventType: string;
  actor: string;
  payload: Record<string, unknown>;
}

async function writeAudit(client: pg.PoolClient, input: AuditInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (incident_id, handoff_id, event_type, actor, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.incidentId, input.handoffId, input.eventType, input.actor, JSON.stringify(input.payload)],
  );
}

async function replayIdempotent<T>(
  client: pg.PoolClient,
  key: string,
  scope: string,
): Promise<T | null> {
  const { rows } = await client.query<{ response: T; scope: string }>(
    'SELECT response, scope FROM idempotency_keys WHERE key = $1',
    [key],
  );
  if (rows.length === 0) return null;
  if (rows[0]!.scope !== scope) {
    throw new ValidationError(`idempotency key ${key} was already used for a different operation`);
  }
  return rows[0]!.response;
}

async function storeIdempotent(
  client: pg.PoolClient,
  key: string,
  scope: string,
  response: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO idempotency_keys (key, scope, response)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO NOTHING`,
    [key, scope, JSON.stringify(response)],
  );
}

/**
 * Test-only: truncate everything and re-seed the canonical incident so browser
 * tests start from a known state. Only reachable via the guarded reset route.
 */
export async function resetForTests(): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`
      TRUNCATE idempotency_keys, audit_events, supplemental_events, acknowledgements,
               handoffs, timeline_events, action_items, incidents RESTART IDENTITY CASCADE;
    `);
    await client.query(
      `INSERT INTO incidents (id, title, severity, status, responsible_party, occurred_at)
       VALUES ('inc-gd-20260729-01', '广东强降水与强对流应急事件', 'high', 'active', '应急指挥中心', '2026-07-29T02:00:00.000Z')`,
    );
    await client.query(
      `INSERT INTO action_items (id, incident_id, title, detail, status, responsible_party, occurred_at)
       VALUES
         ('act-gd-20260729-01-a1', 'inc-gd-20260729-01', '复核东侧绕行路线', '主路封闭后确认东侧绕行路线通行能力与交通引导标识是否到位。', 'in_progress', '交通协调组', '2026-07-29T02:30:00.000Z'),
         ('act-gd-20260729-01-a2', 'inc-gd-20260729-01', '确认临时搭建物撤离结果', '核实低洼区域临时搭建物是否已全部撤离并留存现场照片。', 'open', '现场处置组', '2026-07-29T03:10:00.000Z')`,
    );
    await client.query(
      `INSERT INTO timeline_events (id, incident_id, kind, description, responsible_party, evidence_uri, occurred_at, recorded_at)
       VALUES
         ('tl-gd-20260729-01-e1', 'inc-gd-20260729-01', 'road_closure', '主路（G某段）因积水封闭，双向禁止通行。', '交通协调组', NULL, '2026-07-29T02:20:00.000Z', '2026-07-29T02:25:00.000Z'),
         ('tl-gd-20260729-01-e2', 'inc-gd-20260729-01', 'evidence_intake', '现场巡查证据（积水深度照片与视频）入库。', '现场处置组', 's3://evidence/inc-gd-20260729-01/e2.zip', '2026-07-29T03:00:00.000Z', '2026-07-29T03:45:00.000Z')`,
    );
  });
}
