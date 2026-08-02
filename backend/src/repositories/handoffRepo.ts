import type { PoolClient } from "pg";
import type {
  Handoff,
  Acknowledgement,
  SupplementalEvent,
  SupplementalHandoff,
  ItemType,
} from "../types.js";

export async function createHandoff(
  client: PoolClient,
  handoff: Omit<
    Handoff,
    | "created_at"
    | "signed_off_by"
    | "signed_off_at"
    | "snapshot"
    | "version"
    | "status"
  > &
    Partial<Pick<Handoff, "status" | "snapshot">>,
): Promise<Handoff> {
  const { rows } = await client.query<Handoff>(
    `INSERT INTO handoffs
       (id, incident_id, from_shift, to_shift, summary, status, created_by, snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      handoff.id,
      handoff.incident_id,
      handoff.from_shift,
      handoff.to_shift,
      handoff.summary,
      handoff.status ?? "draft",
      handoff.created_by,
      handoff.snapshot ?? null,
    ],
  );
  return rows[0]!;
}

export async function getHandoff(
  client: PoolClient,
  id: string,
): Promise<Handoff | null> {
  const { rows } = await client.query<Handoff>(
    `SELECT * FROM handoffs WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getHandoffForUpdate(
  client: PoolClient,
  id: string,
): Promise<Handoff | null> {
  const { rows } = await client.query<Handoff>(
    `SELECT * FROM handoffs WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ?? null;
}

export async function signHandoff(
  client: PoolClient,
  id: string,
  snapshot: unknown,
  signedOffBy: string,
): Promise<Handoff | null> {
  const { rows } = await client.query<Handoff>(
    `UPDATE handoffs
     SET status = 'signed',
         snapshot = $2,
         signed_off_by = $3,
         signed_off_at = now(),
         version = version + 1
     WHERE id = $1 AND status = 'draft'
     RETURNING *`,
    [id, snapshot, signedOffBy],
  );
  return rows[0] ?? null;
}

export async function listAcknowledgements(
  client: PoolClient,
  handoffId: string,
): Promise<Acknowledgement[]> {
  const { rows } = await client.query<Acknowledgement>(
    `SELECT * FROM acknowledgements WHERE handoff_id = $1
     ORDER BY acknowledged_at ASC, id ASC`,
    [handoffId],
  );
  return rows;
}

export async function findAcknowledgement(
  client: PoolClient,
  handoffId: string,
  itemType: ItemType,
  itemId: string,
  supplementalHandoffId: string | null,
): Promise<Acknowledgement | null> {
  const { rows } = await client.query<Acknowledgement>(
    `SELECT * FROM acknowledgements
     WHERE handoff_id = $1
       AND item_type = $2
       AND item_id = $3
       AND COALESCE(supplemental_handoff_id, '') = COALESCE($4, '')`,
    [handoffId, itemType, itemId, supplementalHandoffId],
  );
  return rows[0] ?? null;
}

export async function createAcknowledgement(
  client: PoolClient,
  ack: Omit<Acknowledgement, "acknowledged_at">,
): Promise<Acknowledgement | null> {
  const { rows } = await client.query<Acknowledgement>(
    `INSERT INTO acknowledgements
       (id, handoff_id, item_type, item_id, acknowledged_by, note, supplemental_handoff_id, acked_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (handoff_id, (COALESCE(supplemental_handoff_id, '')), item_type, item_id)
     DO NOTHING
     RETURNING *`,
    [
      ack.id,
      ack.handoff_id,
      ack.item_type,
      ack.item_id,
      ack.acknowledged_by,
      ack.note,
      ack.supplemental_handoff_id,
      ack.acked_version,
    ],
  );
  return rows[0] ?? null;
}

export async function createSupplementalHandoff(
  client: PoolClient,
  sh: Omit<SupplementalHandoff, "created_at">,
): Promise<SupplementalHandoff | null> {
  const { rows } = await client.query<SupplementalHandoff>(
    `INSERT INTO supplemental_handoffs
       (id, incident_id, parent_handoff_id, from_shift, to_shift, summary, diff, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (parent_handoff_id) DO NOTHING
     RETURNING *`,
    [
      sh.id,
      sh.incident_id,
      sh.parent_handoff_id,
      sh.from_shift,
      sh.to_shift,
      sh.summary,
      JSON.stringify(sh.diff),
      sh.created_by,
    ],
  );
  return rows[0] ?? null;
}

export async function getSupplementalHandoffByParent(
  client: PoolClient,
  parentHandoffId: string,
): Promise<SupplementalHandoff | null> {
  const { rows } = await client.query<SupplementalHandoff>(
    `SELECT * FROM supplemental_handoffs WHERE parent_handoff_id = $1`,
    [parentHandoffId],
  );
  return rows[0] ?? null;
}

export async function listSupplementalHandoffs(
  client: PoolClient,
  incidentId: string,
): Promise<SupplementalHandoff[]> {
  const { rows } = await client.query<SupplementalHandoff>(
    `SELECT * FROM supplemental_handoffs WHERE incident_id = $1
     ORDER BY created_at ASC, id ASC`,
    [incidentId],
  );
  return rows;
}

export async function createSupplementalEvent(
  client: PoolClient,
  event: Omit<SupplementalEvent, "created_at">,
): Promise<SupplementalEvent> {
  const { rows } = await client.query<SupplementalEvent>(
    `INSERT INTO supplemental_events
       (id, incident_id, parent_handoff_id, kind, description, responsible_party, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      event.id,
      event.incident_id,
      event.parent_handoff_id,
      event.kind,
      event.description,
      event.responsible_party,
      event.occurred_at,
    ],
  );
  return rows[0]!;
}

export async function listSupplementalEvents(
  client: PoolClient,
  parentHandoffId: string,
): Promise<SupplementalEvent[]> {
  const { rows } = await client.query<SupplementalEvent>(
    `SELECT * FROM supplemental_events WHERE parent_handoff_id = $1
     ORDER BY occurred_at ASC, created_at ASC, id ASC`,
    [parentHandoffId],
  );
  return rows;
}
