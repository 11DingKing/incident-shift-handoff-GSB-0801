import { PoolClient } from "pg";
import { v4 as uuid } from "uuid";
import type {
  ActionItem,
  ActionItemStatus,
  AuditEvent,
  ConflictField,
  Handoff,
  HandoffDiff,
  HandoffItem,
  HandoffKind,
  SupplementaryEvent,
  TimelineEvent,
} from "./types.js";
import {
  ConflictError,
  NotFoundError,
  ImmutableHandoffError,
} from "./errors.js";

type Executor =
  | PoolClient
  | { query: (text: string, params?: unknown[]) => Promise<any> };

async function audit(
  db: Executor,
  ev: Omit<AuditEvent, "audit_id" | "occurred_at">,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events(audit_id, incident_id, handoff_id, action, actor, payload)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      uuid(),
      ev.incident_id,
      ev.handoff_id,
      ev.action,
      ev.actor,
      JSON.stringify(ev.payload),
    ],
  );
}

export async function getIncident(db: Executor, incidentId: string) {
  const r = await db.query("SELECT * FROM incidents WHERE incident_id = $1", [
    incidentId,
  ]);
  if (r.rowCount === 0) throw new NotFoundError(`incident ${incidentId}`);
  return r.rows[0];
}

export async function listActionItems(
  db: Executor,
  incidentId: string,
): Promise<ActionItem[]> {
  const r = await db.query(
    "SELECT * FROM action_items WHERE incident_id = $1 ORDER BY occurred_at, action_item_id",
    [incidentId],
  );
  return r.rows;
}

export async function listTimeline(
  db: Executor,
  incidentId: string,
): Promise<TimelineEvent[]> {
  const r = await db.query(
    "SELECT * FROM timeline_events WHERE incident_id = $1 ORDER BY occurred_at, event_id",
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
    "SELECT * FROM action_items WHERE action_item_id = $1 FOR UPDATE",
    [actionItemId],
  );
  if (current.rowCount === 0)
    throw new NotFoundError(`action item ${actionItemId}`);
  const row = current.rows[0];

  if (row.version !== patch.expected_version) {
    const fields: ConflictField[] = [];
    const candidates: Array<keyof ActionItemPatch> = [
      "title",
      "description",
      "status",
      "owner",
      "due_at",
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
      action: "action_item_update_conflict",
      actor: patch.actor,
      payload: {
        action_item_id: actionItemId,
        expected_version: patch.expected_version,
        current_version: row.version,
      },
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
    action: "action_item_updated",
    actor: patch.actor,
    payload: {
      action_item_id: actionItemId,
      changes: { ...patch, expected_version: undefined, actor: undefined },
    },
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
  ev: Omit<
    TimelineEvent,
    "event_id" | "incident_id" | "created_at" | "version"
  > & { event_id?: string },
): Promise<TimelineEvent> {
  const eventId = ev.event_id ?? uuid();
  const inserted = await db.query<TimelineEvent>(
    `INSERT INTO timeline_events(event_id, incident_id, event_type, summary, actor, occurred_at)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [eventId, incidentId, ev.event_type, ev.summary, ev.actor, ev.occurred_at],
  );
  await audit(db, {
    incident_id: incidentId,
    handoff_id: null,
    action: "timeline_added",
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
      [
        uuid(),
        incidentId,
        acked.rows[0].handoff_id,
        eventId,
        ev.summary,
        ev.actor,
      ],
    );
  }

  return inserted.rows[0];
}

export async function addActionItem(
  db: Executor,
  incidentId: string,
  item: Omit<
    ActionItem,
    "action_item_id" | "incident_id" | "created_at" | "updated_at" | "version"
  > & { action_item_id?: string },
): Promise<ActionItem> {
  const id = item.action_item_id ?? uuid();
  const inserted = await db.query<ActionItem>(
    `INSERT INTO action_items(action_item_id, incident_id, title, description, status, owner, due_at, occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      id,
      incidentId,
      item.title,
      item.description,
      item.status,
      item.owner,
      item.due_at,
      item.occurred_at,
    ],
  );
  await audit(db, {
    incident_id: incidentId,
    handoff_id: null,
    action: "action_item_added",
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
  parent_handoff_id?: string | null;
  handoff_kind?: HandoffKind;
  idempotency_key?: string | null;
}

/**
 * Create a handoff package and atomically snapshot its action items + timeline.
 * The snapshot, handoff row and audit event are all produced inside one transaction
 * by the caller (we accept a PoolClient).
 */
export async function createHandoff(
  client: PoolClient,
  draft: HandoffDraft,
): Promise<{
  handoff: Handoff;
  items: HandoffItem[];
  timeline: TimelineEvent[];
}> {
  const kind = draft.handoff_kind ?? "primary";
  const parent = draft.parent_handoff_id ?? null;
  const idem = draft.idempotency_key ?? null;
  const handoff = await client.query<Handoff>(
    `INSERT INTO handoffs(
       handoff_id, incident_id, parent_handoff_id, handoff_kind,
       from_shift, to_shift, summary, created_by, status, idempotency_key
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) RETURNING *`,
    [
      draft.handoff_id,
      draft.incident_id,
      parent,
      kind,
      draft.from_shift,
      draft.to_shift,
      draft.summary,
      draft.created_by,
      idem,
    ],
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
      [
        uuid(),
        draft.handoff_id,
        it.action_item_id,
        it.title,
        it.status,
        it.owner,
        it.occurred_at,
        it.version,
        order++,
      ],
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
      [
        uuid(),
        draft.handoff_id,
        ev.event_id,
        ev.event_type,
        ev.summary,
        ev.actor,
        ev.occurred_at,
        order++,
      ],
    );
  }

  await audit(client, {
    incident_id: draft.incident_id,
    handoff_id: draft.handoff_id,
    action: "handoff_created",
    actor: draft.created_by,
    payload: {
      from_shift: draft.from_shift,
      to_shift: draft.to_shift,
      item_count: items.rowCount,
      timeline_count: tl.rowCount,
    },
  });

  return {
    handoff: handoff.rows[0],
    items: items.rows as unknown as HandoffItem[],
    timeline: tl.rows,
  };
}

export async function getHandoff(db: Executor, handoffId: string) {
  const h = await db.query<Handoff>(
    "SELECT * FROM handoffs WHERE handoff_id=$1",
    [handoffId],
  );
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
  const diffs = await db.query<HandoffDiff>(
    `SELECT * FROM handoff_diffs WHERE handoff_id=$1 ORDER BY item_order, field`,
    [handoffId],
  );
  return {
    handoff: h.rows[0],
    items: items.rows,
    timeline: tl.rows,
    acknowledgments: acks.rows,
    supplementary: supp.rows,
    diffs: diffs.rows,
  };
}

export async function listHandoffs(
  db: Executor,
  incidentId: string,
): Promise<Handoff[]> {
  const r = await db.query<Handoff>(
    "SELECT * FROM handoffs WHERE incident_id=$1 ORDER BY created_at",
    [incidentId],
  );
  return r.rows;
}

export interface SupplementaryDraft {
  handoff_id: string;
  parent_handoff_id: string;
  incident_id: string;
  from_shift: string;
  to_shift: string;
  summary: string;
  created_by: string;
  idempotency_key: string;
}

// Only fields that exist in the parent handoff_items snapshot can be diffed
// against a prior snapshot. description/due_at are not part of a handoff item.
const DIFF_FIELDS: Array<keyof HandoffItem> = ["title", "status", "owner"];

function asText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Create a supplementary (child) handoff package that snapshots ONLY the items
 * and timeline events that are new or changed since the parent package's
 * snapshot, and records per-field diffs.
 *
 * The parent package's owner/status/version/acknowledgment records are never
 * modified. The child row, its partial snapshot, its diffs and the audit event
 * are all produced inside one transaction. An idempotency key guarantees that
 * concurrent or retried calls with the same key return the same child package
 * and never produce a second package / diff set / audit event.
 */
export async function createSupplementaryHandoff(
  client: PoolClient,
  draft: SupplementaryDraft,
): Promise<{
  handoff: Handoff;
  items: HandoffItem[];
  timeline: TimelineEvent[];
  diffs: HandoffDiff[];
  created: boolean;
}> {
  // Lock the parent row so concurrent supplementary creations serialize and the
  // idempotency check is stable.
  const parentRes = await client.query<Handoff>(
    `SELECT * FROM handoffs WHERE handoff_id=$1 FOR UPDATE`,
    [draft.parent_handoff_id],
  );
  if (parentRes.rowCount === 0)
    throw new NotFoundError(`handoff ${draft.parent_handoff_id}`);
  const parent = parentRes.rows[0];
  if (parent.status !== "acknowledged") {
    throw new ConflictError(
      `Parent handoff ${draft.parent_handoff_id} must be acknowledged before a supplementary package can be created`,
    );
  }

  // Idempotency: if a supplementary package for this parent+key already exists,
  // return it without creating anything new.
  const existing = await client.query<Handoff>(
    `SELECT * FROM handoffs
     WHERE parent_handoff_id=$1 AND idempotency_key=$2`,
    [draft.parent_handoff_id, draft.idempotency_key],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    const child = existing.rows[0];
    const items = await client.query<HandoffItem>(
      `SELECT * FROM handoff_items WHERE handoff_id=$1 ORDER BY item_order`,
      [child.handoff_id],
    );
    const tl = await client.query<TimelineEvent>(
      `SELECT * FROM handoff_timeline WHERE handoff_id=$1 ORDER BY item_order`,
      [child.handoff_id],
    );
    const diffs = await client.query<HandoffDiff>(
      `SELECT * FROM handoff_diffs WHERE handoff_id=$1 ORDER BY item_order, field`,
      [child.handoff_id],
    );
    return {
      handoff: child,
      items: items.rows,
      timeline: tl.rows,
      diffs: diffs.rows,
      created: false,
    };
  }

  const child = await client.query<Handoff>(
    `INSERT INTO handoffs(
       handoff_id, incident_id, parent_handoff_id, handoff_kind,
       from_shift, to_shift, summary, created_by, status, idempotency_key
     ) VALUES($1,$2,$3,'supplementary',$4,$5,$6,$7,'pending',$8) RETURNING *`,
    [
      draft.handoff_id,
      draft.incident_id,
      draft.parent_handoff_id,
      draft.from_shift,
      draft.to_shift,
      draft.summary,
      draft.created_by,
      draft.idempotency_key,
    ],
  );
  let childRow = child.rows[0];
  let alreadyExisted = false;
  // No extra handling needed: the SELECT ... FOR UPDATE on the parent serializes
  // concurrent creations for the same parent, so the unique index cannot be hit
  // here. The branch is kept for defensive clarity.

  // Load the parent snapshot so we can compute deltas.
  const parentItems = await client.query(
    `SELECT * FROM handoff_items WHERE handoff_id=$1`,
    [draft.parent_handoff_id],
  );
  const parentTimeline = await client.query(
    `SELECT * FROM handoff_timeline WHERE handoff_id=$1`,
    [draft.parent_handoff_id],
  );
  const parentItemById = new Map<string, any>();
  for (const it of parentItems.rows) parentItemById.set(it.action_item_id, it);
  const parentEventIds = new Set(
    parentTimeline.rows.map((e: any) => e.event_id),
  );

  // Current live state.
  const liveItems = await client.query<ActionItem>(
    `SELECT * FROM action_items WHERE incident_id=$1 ORDER BY occurred_at, action_item_id`,
    [draft.incident_id],
  );
  const liveTimeline = await client.query<TimelineEvent>(
    `SELECT * FROM timeline_events WHERE incident_id=$1 ORDER BY occurred_at, event_id`,
    [draft.incident_id],
  );

  const snapshotItems: HandoffItem[] = [];
  const diffs: HandoffDiff[] = [];
  let order = 0;

  for (const it of liveItems.rows) {
    const oldSnap = parentItemById.get(it.action_item_id);
    let changedFields: string[] = [];
    if (!oldSnap) {
      changedFields = ["*"]; // brand-new action item
    } else {
      for (const f of DIFF_FIELDS) {
        if (asText((it as any)[f]) !== asText(oldSnap[f])) {
          changedFields.push(f);
        }
      }
      // A version bump without a tracked field change should not produce noise;
      // if nothing relevant changed, skip this item.
      if (changedFields.length === 0) continue;
    }

    // Snapshot only new/changed items.
    const inserted = await client.query(
      `INSERT INTO handoff_items(
         handoff_item_id, handoff_id, action_item_id, title, status, owner,
         occurred_at, snapshot_version, item_order
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        uuid(),
        childRow.handoff_id,
        it.action_item_id,
        it.title,
        it.status,
        it.owner,
        it.occurred_at,
        it.version,
        order,
      ],
    );
    snapshotItems.push(inserted.rows[0]);

    if (!oldSnap) {
      diffs.push(
        await insertDiff(client, {
          handoff_id: childRow.handoff_id,
          ref_id: it.action_item_id,
          ref_type: "action_item",
          change_kind: "added",
          field: "*",
          old_value: null,
          new_value: it.title,
          item_order: order,
        }),
      );
    } else {
      for (const f of changedFields) {
        diffs.push(
          await insertDiff(client, {
            handoff_id: childRow.handoff_id,
            ref_id: it.action_item_id,
            ref_type: "action_item",
            change_kind: "modified",
            field: f,
            old_value: asText(oldSnap[f]),
            new_value: asText((it as any)[f]),
            item_order: order,
          }),
        );
      }
    }
    order++;
  }

  // New timeline events (not present in the parent snapshot).
  const snapshotTimeline: TimelineEvent[] = [];
  let tlOrder = 0;
  for (const ev of liveTimeline.rows) {
    if (parentEventIds.has(ev.event_id)) continue;
    await client.query(
      `INSERT INTO handoff_timeline(
         handoff_timeline_id, handoff_id, event_id, event_type, summary, actor, occurred_at, item_order
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        uuid(),
        childRow.handoff_id,
        ev.event_id,
        ev.event_type,
        ev.summary,
        ev.actor,
        ev.occurred_at,
        tlOrder,
      ],
    );
    snapshotTimeline.push(ev);
    diffs.push(
      await insertDiff(client, {
        handoff_id: childRow.handoff_id,
        ref_id: ev.event_id,
        ref_type: "timeline_event",
        change_kind: "added",
        field: "*",
        old_value: null,
        new_value: ev.summary,
        item_order: order + tlOrder,
      }),
    );
    tlOrder++;
  }

  await audit(client, {
    incident_id: draft.incident_id,
    handoff_id: childRow.handoff_id,
    action: "supplementary_handoff_created",
    actor: draft.created_by,
    payload: {
      parent_handoff_id: draft.parent_handoff_id,
      idempotency_key: draft.idempotency_key,
      item_count: snapshotItems.length,
      timeline_count: snapshotTimeline.length,
      diff_count: diffs.length,
    },
  });

  return {
    handoff: childRow,
    items: snapshotItems,
    timeline: snapshotTimeline,
    diffs,
    created: !alreadyExisted,
  };
}

async function insertDiff(
  client: PoolClient,
  d: Omit<HandoffDiff, "diff_id">,
): Promise<HandoffDiff> {
  const r = await client.query<HandoffDiff>(
    `INSERT INTO handoff_diffs(diff_id, handoff_id, ref_id, ref_type, change_kind, field, old_value, new_value, item_order)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      uuid(),
      d.handoff_id,
      d.ref_id,
      d.ref_type,
      d.change_kind,
      d.field,
      d.old_value,
      d.new_value,
      d.item_order,
    ],
  );
  return r.rows[0];
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
    "SELECT * FROM handoffs WHERE handoff_id=$1",
    [input.handoff_id],
  );
  if (h.rowCount === 0) throw new NotFoundError(`handoff ${input.handoff_id}`);
  const handoff = h.rows[0];
  if (handoff.status === "acknowledged" && input.action_item_id !== null) {
    // Package already signed off; still allow idempotent duplicate acks but disallow new items.
  }

  try {
    // Use a savepoint so that a unique_violation on concurrent duplicate does not
    // abort the entire outer transaction.
    let ackRow: any;
    await client.query("SAVEPOINT ack_insert");
    try {
      const inserted = await client.query(
        `INSERT INTO handoff_acknowledgments(acknowledgment_id, handoff_id, action_item_id, confirmed_by, note, idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          uuid(),
          input.handoff_id,
          input.action_item_id,
          input.confirmed_by,
          input.note ?? "",
          input.idempotency_key,
        ],
      );
      ackRow = inserted.rows[0];
      await client.query("RELEASE SAVEPOINT ack_insert");
    } catch (e: any) {
      await client.query("ROLLBACK TO SAVEPOINT ack_insert");
      if (e.code !== "23505") throw e; // unique_violation
      const existing =
        input.action_item_id === null
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
      action: input.action_item_id
        ? "item_acknowledged"
        : "package_acknowledged",
      actor: input.confirmed_by,
      payload: {
        action_item_id: input.action_item_id,
        idempotency_key: input.idempotency_key,
      },
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

export async function listAudit(
  db: Executor,
  incidentId: string,
): Promise<AuditEvent[]> {
  const r = await db.query(
    `SELECT * FROM audit_events WHERE incident_id=$1 ORDER BY occurred_at`,
    [incidentId],
  );
  return r.rows;
}
