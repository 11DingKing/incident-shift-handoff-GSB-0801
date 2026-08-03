import type { PoolClient } from "pg";
import type { AuditEvent } from "../types.js";

export async function createAuditEvent(
  client: PoolClient,
  event: Omit<AuditEvent, "id" | "created_at">
): Promise<AuditEvent> {
  const { rows } = await client.query<AuditEvent>(
    `INSERT INTO audit_events
       (incident_id, handoff_id, event_type, actor, payload)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [
      event.incident_id,
      event.handoff_id,
      event.event_type,
      event.actor,
      JSON.stringify(event.payload),
    ]
  );
  return rows[0]!;
}

export async function listAuditEvents(
  client: PoolClient,
  filter: { incidentId?: string; handoffId?: string; limit?: number }
): Promise<AuditEvent[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filter.incidentId) {
    values.push(filter.incidentId);
    clauses.push(`incident_id = $${values.length}`);
  }
  if (filter.handoffId) {
    values.push(filter.handoffId);
    clauses.push(`handoff_id = $${values.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  values.push(filter.limit ?? 200);
  const { rows } = await client.query<AuditEvent>(
    `SELECT * FROM audit_events ${where}
     ORDER BY id DESC, created_at DESC
     LIMIT $${values.length}`,
    values
  );
  return rows;
}

export async function getIdempotency(
  client: PoolClient,
  key: string
): Promise<{ scope: string; response: Record<string, unknown> } | null> {
  const { rows } = await client.query<{
    scope: string;
    response: Record<string, unknown>;
  }>(`SELECT scope, response FROM idempotency_keys WHERE key = $1`, [key]);
  return rows[0] ?? null;
}

export async function storeIdempotency(
  client: PoolClient,
  key: string,
  scope: string,
  response: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO idempotency_keys (key, scope, response)
     VALUES ($1,$2,$3)
     ON CONFLICT (key) DO NOTHING`,
    [key, scope, JSON.stringify(response)]
  );
}
