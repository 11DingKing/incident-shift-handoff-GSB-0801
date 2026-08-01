// Domain types mirrored from the backend responses.

export type ActionItemStatus = 'open' | 'in_progress' | 'blocked' | 'done';

export interface Incident {
  id: string;
  title: string;
  severity: string;
  status: string;
  responsible_party: string;
  occurred_at: string;
  version: number;
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
}

export interface Handoff {
  id: string;
  incident_id: string;
  from_shift: string;
  to_shift: string;
  summary: string;
  status: 'draft' | 'signed';
  snapshot: {
    incident: Incident;
    action_items: ActionItem[];
    timeline_events: TimelineEvent[];
    captured_at: string;
  } | null;
  created_by: string;
  created_at: string;
  signed_off_by: string | null;
  signed_off_at: string | null;
  version: number;
  acknowledgements: Acknowledgement[];
  supplemental_events: SupplementalEvent[];
}

export interface IncidentBundle {
  incident: Incident;
  action_items: ActionItem[];
  timeline_events: TimelineEvent[];
  handoffs: Handoff[];
}

export interface ConflictBody {
  error: 'version_conflict';
  message: string;
  entity: string;
  id: string;
  expected_version: number;
  actual_version: number;
  conflicts: Record<string, { current: unknown }>;
  current: Record<string, unknown>;
}
