import type { PoolClient } from "pg";
import type { ActionItem, ActionItemStatus } from "../types.js";

export interface ActionItemPatch {
  title?: string;
  detail?: string;
  status?: ActionItemStatus;
  responsible_party?: string;
  occurred_at?: string;
}

export async function getActionItem(
  client: PoolClient,
  id: string
): Promise<ActionItem | null> {
  const { rows } = await client.query<ActionItem>(
    `SELECT * FROM action_items WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function getActionItemForUpdate(
  client: PoolClient,
  id: string
): Promise<ActionItem | null> {
  const { rows } = await client.query<ActionItem>(
    `SELECT * FROM action_items WHERE id = $1 FOR UPDATE`,
    [id]
  );
  return rows[0] ?? null;
}

export async function getRevision(
  client: PoolClient,
  id: string,
  version: number
): Promise<ActionItem | null> {
  const { rows } = await client.query<ActionItem>(
    `SELECT action_item_id AS id, version, title, detail, status, responsible_party, occurred_at, created_at
     FROM action_item_revisions
     WHERE action_item_id = $1 AND version = $2`,
    [id, version]
  );
  return rows[0] ?? null;
}

export async function updateActionItem(
  client: PoolClient,
  id: string,
  expectedVersion: number,
  patch: ActionItemPatch
): Promise<ActionItem | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  const fields: (keyof ActionItemPatch)[] = [
    "title",
    "detail",
    "status",
    "responsible_party",
    "occurred_at",
  ];
  for (const field of fields) {
    if (patch[field] !== undefined) {
      sets.push(`${field} = $${idx++}`);
      values.push(patch[field]);
    }
  }
  if (sets.length === 0) {
    return getActionItem(client, id);
  }
  sets.push(`version = version + 1`);
  sets.push(`updated_at = now()`);
  values.push(id, expectedVersion);

  const { rows } = await client.query<ActionItem>(
    `UPDATE action_items
     SET ${sets.join(", ")}
     WHERE id = $${idx++} AND version = $${idx++}
     RETURNING *`,
    values
  );
  return rows[0] ?? null;
}

export async function insertRevision(
  client: PoolClient,
  item: ActionItem
): Promise<void> {
  await client.query(
    `INSERT INTO action_item_revisions
       (action_item_id, version, title, detail, status, responsible_party, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (action_item_id, version) DO NOTHING`,
    [
      item.id,
      item.version,
      item.title,
      item.detail,
      item.status,
      item.responsible_party,
      item.occurred_at,
    ]
  );
}
