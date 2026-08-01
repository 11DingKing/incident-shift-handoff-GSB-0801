// Shared domain types for the incident shift-handoff service.

export interface Incident {
  id: string;
  title: string;
  severity: string;
  status: 'active' | 'monitoring' | 'closed';
  responsible_party: string;
  occurred_at: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export type ActionItemStatus = 'open' | 'in_progress' | 'blocked' | 'done';

export interface ActionItem {
  id: string;
  incident_id: string;
  title: string;
  detail: string;
  status: ActionItemStatus;
  responsible_party: string;
  occurred_at: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface TimelineEvent {
  id: string;
  incident_id: string;
  kind: string;
  description: string;
  responsible_party: string;
  evidence_uri: string | null;
  occurred_at: string;
  recorded_at: string;
  created_at: string;
}

export interface Handoff {
  id: string;
  incident_id: string;
  from_shift: string;
  to_shift: string;
  summary: string;
  status: 'draft' | 'signed';
  snapshot: HandoffSnapshot | null;
  created_by: string;
  created_at: string;
  signed_off_by: string | null;
  signed_off_at: string | null;
  version: number;
}

export interface HandoffSnapshot {
  incident: Incident;
  action_items: ActionItem[];
  timeline_events: TimelineEvent[];
  captured_at: string;
}

export interface Acknowledgement {
  id: string;
  handoff_id: string;
  item_type: 'action_item' | 'timeline_event';
  item_id: string;
  acknowledged_by: string;
  note: string;
  acknowledged_at: string;
}

export interface SupplementalEvent {
  id: string;
  incident_id: string;
  parent_handoff_id: string;
  kind: string;
  description: string;
  responsible_party: string;
  occurred_at: string;
  created_at: string;
}

/** Field-level optimistic-lock conflict body returned with HTTP 409. */
export interface ConflictBody {
  error: 'version_conflict';
  message: string;
  entity: string;
  id: string;
  expected_version: number;
  actual_version: number;
  // Only the fields that actually differ between the client's stale copy and
  // the current row, so the UI can show a precise field-level diff.
  conflicts: Record<string, { current: unknown }>;
  current: Record<string, unknown>;
}
