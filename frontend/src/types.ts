export type ActionItemStatus = 'open' | 'in_progress' | 'done' | 'blocked';
export type HandoffStatus = 'pending' | 'acknowledged';

export interface Incident {
  incident_id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface ActionItem {
  action_item_id: string;
  incident_id: string;
  title: string;
  description: string;
  status: ActionItemStatus;
  owner: string;
  due_at: string | null;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface TimelineEvent {
  event_id: string;
  incident_id: string;
  event_type: string;
  summary: string;
  actor: string;
  occurred_at: string;
  created_at: string;
  version: number;
}

export type HandoffKind = 'primary' | 'supplementary';

export interface Handoff {
  handoff_id: string;
  incident_id: string;
  parent_handoff_id: string | null;
  handoff_kind: HandoffKind;
  from_shift: string;
  to_shift: string;
  summary: string;
  created_by: string;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  status: HandoffStatus;
  version: number;
  idempotency_key: string | null;
}

export interface HandoffDiff {
  diff_id: string;
  handoff_id: string;
  ref_id: string;
  ref_type: 'action_item' | 'timeline_event';
  change_kind: 'added' | 'modified';
  field: string;
  old_value: string | null;
  new_value: string | null;
  item_order: number;
}

export interface HandoffItem {
  handoff_item_id: string;
  handoff_id: string;
  action_item_id: string;
  title: string;
  status: ActionItemStatus;
  owner: string;
  occurred_at: string;
  snapshot_version: number;
  item_order: number;
}

export interface HandoffAcknowledgment {
  acknowledgment_id: string;
  handoff_id: string;
  action_item_id: string | null;
  confirmed_by: string;
  confirmed_at: string;
  note: string;
  idempotency_key: string;
}

export interface SupplementaryEvent {
  supplementary_id: string;
  incident_id: string;
  handoff_id: string;
  change_type: string;
  ref_id: string;
  summary: string;
  actor: string;
  occurred_at: string;
  version: number;
}

export interface HandoffDetail {
  handoff: Handoff;
  items: HandoffItem[];
  timeline: TimelineEvent[];
  acknowledgments: HandoffAcknowledgment[];
  supplementary: SupplementaryEvent[];
  diffs: HandoffDiff[];
  parent?: HandoffDetail | null;
}

export interface ConflictField {
  field: string;
  submitted: unknown;
  current: unknown;
  current_version: number;
}

export class ApiError extends Error {
  status: number;
  conflictFields?: ConflictField[];
  constructor(status: number, message: string, conflictFields?: ConflictField[]) {
    super(message);
    this.status = status;
    this.conflictFields = conflictFields;
  }
}
