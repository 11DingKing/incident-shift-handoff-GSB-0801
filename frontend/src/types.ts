export type IncidentStatus = "active" | "monitoring" | "closed";
export type ActionItemStatus = "open" | "in_progress" | "blocked" | "done";
export type HandoffStatus = "draft" | "signed";
export type ItemType = "action_item" | "timeline_event";

export interface Incident {
  id: string;
  title: string;
  severity: string;
  status: IncidentStatus;
  responsible_party: string;
  occurred_at: string;
  version: number;
  created_at: string;
  updated_at: string;
}

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

export interface SnapshotData {
  incident: Incident;
  action_items: ActionItem[];
  timeline_events: TimelineEvent[];
  captured_at: string;
}

export interface Handoff {
  id: string;
  incident_id: string;
  from_shift: string;
  to_shift: string;
  summary: string;
  status: HandoffStatus;
  snapshot: SnapshotData | null;
  created_by: string;
  created_at: string;
  signed_off_by: string | null;
  signed_off_at: string | null;
  version: number;
}

export interface Acknowledgement {
  id: string;
  handoff_id: string;
  item_type: ItemType;
  item_id: string;
  acknowledged_by: string;
  note: string;
  acknowledged_at: string;
  supplemental_handoff_id: string | null;
  acked_version: number | null;
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

export interface SupplementalHandoff {
  id: string;
  incident_id: string;
  parent_handoff_id: string;
  from_shift: string;
  to_shift: string;
  summary: string;
  diff: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

export interface IncidentDetail {
  incident: Incident;
  action_items: ActionItem[];
  timeline_events: TimelineEvent[];
  handoffs: Handoff[];
}

export interface HandoffDetail {
  handoff: Handoff;
  acknowledgements: Acknowledgement[];
  supplemental_events: SupplementalEvent[];
  supplemental_handoff: SupplementalHandoff | null;
}

export interface FieldConflict {
  field: string;
  base: unknown;
  current: unknown;
  attempted: unknown;
}

export interface OptimisticLockConflict {
  error: "optimistic_lock_conflict";
  message: string;
  currentVersion: number;
  conflicts: FieldConflict[];
  current: ActionItem;
}
