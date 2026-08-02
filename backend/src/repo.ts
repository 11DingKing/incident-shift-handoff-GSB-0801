import { PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';
import type {
  ActionItem,
  ActionItemStatus,
  AuditEvent,
  ConflictField,
  Handoff,
  HandoffItem,
  SupplementaryEvent,
  TimelineEvent,
} from './types.js';
import { ConflictError, NotFoundError, ImmutableHandoffError } from './errors.js';

type Executor = PoolClient | { query: (text: string, params?: unknown[]) => Promise<any> };

async function audit(
  db: Executor,
  ev: Omit<AuditEvent, 'audit_id' | 'occurred_at'>,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events(audit_id, incident_id, handoff_id, action, actor, payload)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [uuid(), ev.incident_id, ev.handoff_id, ev.action, ev.actor, JSON.stringify(ev.payload)],
  );
}

export async function getIncident(db: Executor, incidentId: string) {
  const r = await db.query('SELECT * FROM incidents WHERE incident_id = $1', [incidentId]);
  if (r.rowCount === 0) throw new NotFoundError(`incident ${incidentId}`);
  return r.rows[0];
}

export async function listActionItems(db: Executor, incidentId: string): Promise<ActionItem[]> {
  const r = await db.query(
    'SELECT * FROM action_items WHERE incident_id = $1 ORDER BY occurred_at, action_item_id',
    [incidentId],
  );
  return r.rows;
}

export async function listTimeline(db: Executor, incidentId: string): Promise<TimelineEvent[]> {
  const r = await db.query(
    'SELECT * FROM timeline_events WHERE incident_id = $1 ORDER BY occurred_at, event_id',
    [incidentId],
  );
  return r.rows;
}

export interface ActionItemPatch {
  title?: string;
  description?: string;
  status?: ActionItemStatus;
  owner?: string;
  due_at?: string | null;
  expected_version: number;
  actor: string;
}

/**
 * Update an action item using optimistic locking.
 * If expected_version does not match the current row version, we return a 409
 * with field-level conflict details (which submitted fields differ from current values)
 * rather than silently overwriting.
 */
export async function updateActionItem(
  db: Executor,
  actionItemId: string,
  patch: ActionItemPatch,
): Promise<ActionItem> {
  const current = await db.query<ActionItem>(
    'SELECT * FROM action_items WHERE action_item_id = $1 FOR UPDATE',
    [actionItemId],
  );
  if (current.rowCount === 0) throw new NotFoundError(`action item ${actionItemId}`);
  const row = current.rows[0];

  if (row.version !== patch.expected_version) {
    const fields: ConflictField[] = [];
    const candidates: Array<keyof ActionItemPatch> = [
      'title', 'description', 'status', 'owner', 'due_at',
    ];
    for (const key of candidates) {
      if (patch[key] !== undefined && patch[key] !== (row as any)[key]) {
        fields.push({
          field: key,
          submitted: patch[key],
          current: (row as any)[key],
          current_version: row.version,
        });
      }
    }
    await audit(db, {
      incident_id: row.incident_id,
      handoff_id: null,
      action: 'action_item_update_conflict',
      actor: patch.actor,
      payload: { action_item_id: actionItemId, expected_version: patch.expected_version, current_version: row.version },
    });
    throw new ConflictError(
      `Action item ${actionItemId} was modified by someone else (current version ${row.version}, you sent ${patch.expected_version})`,
      fields,
    );
  }

  const nextTitle = patch.title ?? row.title;
  const nextDesc = patch.description ?? row.description;
  const nextStatus = patch.status ?? row.status;
  const nextOwner = patch.owner ?? row.owner;
  const nextDue = patch.due_at === undefined ? row.due_at : patch.due_at;

  const updated = await db.query<ActionItem>(
    `UPDATE action_items
       SET title=$1, description=$2, status=$3, owner=$4, due_at=$5,
           updated_at=now(), version=version+1
     WHERE action_item_id=$6
     RETURNING *`,
    [nextTitle, nextDesc, nextStatus, nextOwner, nextDue, actionItemId],
  );

  await audit(db, {
    incident_id: row.incident_id,
    handoff_id: null,
    action: 'action_item_updated',
    actor: patch.actor,
    payload: { action_item_id: actionItemId, changes: { ...patch, expected_version: undefined, actor: undefined } },
  });

  // If there's an acknowledged handoff for this incident, append a supplementary event
  // so incoming shift sees the change after sign-off.
  const acked = await db.query<Handoff>(
    `SELECT * FROM handoffs WHERE incident_id=$1 AND status='acknowledged'
     ORDER BY acknowledged_at DESC LIMIT 1`,
    [row.incident_id],
  );
  if (acked.rowCount && acked.rowCount > 0) {
    await db.query(
      `INSERT INTO supplementary_events(supplementary_id, incident_id, handoff_id, change_type, ref_id, summary, actor)
       VALUES($1,$2,$3,'action_item_updated',$4,$5,$6)`,
      [
        uuid(),
        row.incident_id,
        acked.rows[0].handoff_id,
        actionItemId,
        `行动项「${nextTitle}」状态更新为 ${nextStatus}`,
        patch.actor,
      ],
    );
  }

  return updated.rows[0];
}

export async function addTimelineEvent(
  db: Executor,
  incidentId: string,
  ev: Omit<TimelineEvent, 'event_id' | 'incident_id' | 'created_at' | 'version'>,
): Promise<TimelineEvent> {
  const eventId = ev.event_type ? uuid() : uuid();
  const inserted = await db.query<TimelineEvent>(
    `INSERT INTO timeline_events(event_id, incident_id, event_type, summary, actor, occurred_at)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [eventId, incidentId, ev.event_type, ev.summary, ev.actor, ev.occurred_at],
  );
  await audit(db, {
    incident_id: incidentId,
    handoff_id: null,
    action: 'timeline_added',
    actor: ev.actor,
    payload: { event_id: eventId, event_type: ev.event_type },
  });

  const acked = await db.query<Handoff>(
    `SELECT * FROM handoffs WHERE incident_id=$1 AND status='acknowledged'
     ORDER BY acknowledged_at DESC LIMIT 1`,
    [incidentId],
  );
  if (acked.rowCount && acked.rowCount > 0) {
    await db.query(
      `INSERT INTO supplementary_events(supplementary_id, incident_id, handoff_id, change_type, ref_id, summary, actor)
       VALUES($1,$2,$3,'timeline_added',$4,$5,$6)`,
      [uuid(), incidentId, acked.rows[0].handoff_id, eventId, ev.summary, ev.actor],
    );
  }

  return inserted.rows[0];
}

export async function addActionItem(
  db: Executor,
  incidentId: string,
  item: Omit<ActionItem, 'action_item_id' | 'incident_id' | 'created_at' | 'updated_at' | 'version'>,
): Promise<ActionItem> {
  const id = uuid();
  const inserted = await db.query<ActionItem>(
    `INSERT INTO action_items(action_item_id, incident_id, title, description, status, owner, due_at, occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id, incidentId, item.title, item.description, item.status, item.owner, item.due_at, item.occurred_at],
  );
  await audit(db, {
    incident_id: incidentId,
    handoff_id: null,
    action: 'action_item_added',
    actor: item.owner,
    payload: { action_item_id: id },
  });
  return inserted.rows[0];
}

export interface HandoffDraft {
  handoff_id: string;
  incident_id: string;
  from_shift: string;
  to_shift: string;
  summary: string;
  created_by: string;
}

/**
 * Create a handoff package and atomically snapshot its action items + timeline.
 * The snapshot, handoff row and audit event are all produced inside one transaction
 * by the caller (we accept a PoolClient).
 */
export async function createHandoff(
  client: PoolClient,
  draft: HandoffDraft,
): Promise<{ handoff: Handoff; items: HandoffItem[]; timeline: TimelineEvent[] }> {
  const handoff = await client.query<Handoff>(
    `INSERT INTO handoffs(handoff_id, incident_id, from_shift, to_shift, summary, created_by, status)
     VALUES($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
    [draft.handoff_id, draft.incident_id, draft.from_shift, draft.to_shift, draft.summary, draft.created_by],
  );

  const items = await client.query<ActionItem>(
    `SELECT * FROM action_items WHERE incident_id=$1 ORDER BY occurred_at, action_item_id`,
    [draft.incident_id],
  );

  let order = 0;
  for (const it of items.rows) {
    await client.query(
      `INSERT INTO handoff_items(handoff_item_id, handoff_id, action_item_id, title, status, owner, occurred_at, snapshot_version, item_order)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uuid(), draft.handoff_id, it.action_item_id, it.title, it.status, it.owner, it.occurred_at, it.version, order++],
    );
  }

  const tl = await client.query<TimelineEvent>(
    `SELECT * FROM timeline_events WHERE incident_id=$1 ORDER BY occurred_at, event_id`,
    [draft.incident_id],
  );
  order = 0;
  for (const ev of tl.rows) {
    await client.query(
      `INSERT INTO handoff_timeline(handoff_timeline_id, handoff_id, event_id, event_type, summary, actor, occurred_at, item_order)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uuid(), draft.handoff_id, ev.event_id, ev.event_type, ev.summary, ev.actor, ev.occurred_at, order++],
    );
  }

  await audit(client, {
    incident_id: draft.incident_id,
    handoff_id: draft.handoff_id,
    action: 'handoff_created',
    actor: draft.created_by,
    payload: { from_shift: draft.from_shift, to_shift: draft.to_shift, item_count: items.rowCount, timeline_count: tl.rowCount },
  });

  return { handoff: handoff.rows[0], items: items.rows as unknown as HandoffItem[], timeline: tl.rows };
}

export async function getHandoff(db: Executor, handoffId: string) {
  const h = await db.query<Handoff>('SELECT * FROM handoffs WHERE handoff_id=$1', [handoffId]);
  if (h.rowCount === 0) throw new NotFoundError(`handoff ${handoffId}`);
  const items = await db.query(
    `SELECT * FROM handoff_items WHERE handoff_id=$1 ORDER BY item_order`,
    [handoffId],
  );
  const tl = await db.query(
    `SELECT * FROM handoff_timeline WHERE handoff_id=$1 ORDER BY item_order`,
    [handoffId],
  );
  const acks = await db.query(
    `SELECT * FROM handoff_acknowledgments WHERE handoff_id=$1 ORDER BY confirmed_at`,
    [handoffId],
  );
  const supp = await db.query<SupplementaryEvent>(
    `SELECT * FROM supplementary_events WHERE handoff_id=$1 ORDER BY occurred_at`,
    [handoffId],
  );
  return {
    handoff: h.rows[0],
    items: items.rows,
    timeline: tl.rows,
    acknowledgments: acks.rows,
    supplementary: supp.rows,
  };
}

export async function listHandoffs(db: Executor, incidentId: string): Promise<Handoff[]> {
  const r = await db.query<Handoff>(
    'SELECT * FROM handoffs WHERE incident_id=$1 ORDER BY created_at',
    [incidentId],
  );
  return r.rows;
}

export interface AckInput {
  handoff_id: string;
  action_item_id: string | null;
  confirmed_by: string;
  note?: string;
  idempotency_key: string;
}

/**
 * Idempotent per-item (or package-level) acknowledgment.
 * UNIQUE(handoff_id, action_item_id, confirmed_by) makes retries safe.
 * Acknowledging the package flips handoff status to acknowledged atomically.
 * Crucially, unconfirmed action items are NOT auto-closed here.
 */
export async function acknowledge(
  client: PoolClient,
  input: AckInput,
): Promise<{ ack: any; packageAcknowledged: boolean }> {
  const h = await client.query<Handoff>(
    'SELECT * FROM handoffs WHERE handoff_id=$1',
    [input.handoff_id],
  );
  if (h.rowCount === 0) throw new NotFoundError(`handoff ${input.handoff_id}`);
  const handoff = h.rows[0];
  if (handoff.status === 'acknowledged' && input.action_item_id !== null) {
    // Package already signed off; still allow idempotent duplicate acks but disallow new items.
  }

  try {
    // Use a savepoint so that a unique_violation on concurrent duplicate does not
    // abort the entire outer transaction.
    let ackRow: any;
    await client.query('SAVEPOINT ack_insert');
    try {
      const inserted = await client.query(
        `INSERT INTO handoff_acknowledgments(acknowledgment_id, handoff_id, action_item_id, confirmed_by, note, idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [uuid(), input.handoff_id, input.action_item_id, input.confirmed_by, input.note ?? '', input.idempotency_key],
      );
      ackRow = inserted.rows[0];
      await client.query('RELEASE SAVEPOINT ack_insert');
    } catch (e: any) {
      await client.query('ROLLBACK TO SAVEPOINT ack_insert');
      if (e.code !== '23505') throw e; // unique_violation
      const existing = input.action_item_id === null
        ? await client.query(
            `SELECT * FROM handoff_acknowledgments
             WHERE handoff_id=$1 AND confirmed_by=$2 AND action_item_id IS NULL`,
            [input.handoff_id, input.confirmed_by],
          )
        : await client.query(
            `SELECT * FROM handoff_acknowledgments
             WHERE handoff_id=$1 AND action_item_id=$2 AND confirmed_by=$3`,
            [input.handoff_id, input.action_item_id, input.confirmed_by],
          );
      ackRow = existing.rows[0];
    }

    await audit(client, {
      incident_id: handoff.incident_id,
      handoff_id: input.handoff_id,
      action: input.action_item_id ? 'item_acknowledged' : 'package_acknowledged',
      actor: input.confirmed_by,
      payload: { action_item_id: input.action_item_id, idempotency_key: input.idempotency_key },
    });

    // Package-level acknowledgment (action_item_id null) flips the handoff status.
    // The WHERE status='pending' guard makes concurrent duplicate calls safe: only
    // the first one flips the row and bumps version.
    let packageAcknowledged = false;
    if (input.action_item_id === null) {
      const flip = await client.query(
        `UPDATE handoffs SET status='acknowledged', acknowledged_at=now(), acknowledged_by=$1, version=version+1
         WHERE handoff_id=$2 AND status='pending'`,
        [input.confirmed_by, input.handoff_id],
      );
      packageAcknowledged = (flip.rowCount ?? 0) > 0;
    }
    return { ack: ackRow, packageAcknowledged };
  } catch (err: any) {
    throw err;
  }
}

export async function listAudit(db: Executor, incidentId: string): Promise<AuditEvent[]> {
  const r = await db.query(
    `SELECT * FROM audit_events WHERE incident_id=$1 ORDER BY occurred_at`,
    [incidentId],
  );
  return r.rows;
}
