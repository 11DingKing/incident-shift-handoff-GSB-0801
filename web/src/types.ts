export interface Incident {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

export type ActionItemStatus = 'open' | 'in_progress' | 'done' | 'verified';

export interface ActionItem {
  id: string;
  incident_id: string;
  title: string;
  owner: string;
  status: ActionItemStatus;
  version: number;
  occurred_at: string;
  updated_at: string;
}

export interface Handoff {
  id: string;
  incident_id: string;
  from_shift: string;
  to_shift: string;
  note: string;
  status: 'draft' | 'signed';
  version: number;
  created_by: string;
  created_at: string;
  signed_at: string | null;
}

export interface HandoffItem {
  id: string; // action_item_id
  handoff_id?: string;
  title: string;
  owner: string;
  status_at_sign: string;
  version_at_sign: number;
  confirmed: boolean;
  confirmed_by: string | null;
  confirmed_at: string | null;
}

export interface TimelineEvent {
  id: string;
  incident_id: string;
  handoff_id: string | null;
  kind: 'evidence' | 'supplement' | 'audit';
  title: string;
  detail: string;
  owner: string;
  occurred_at: string;
  created_at: string;
}

export interface Overview {
  incident: Incident;
  actionItems: ActionItem[];
  handoffs: Handoff[];
}

export interface HandoffDetail {
  handoff: Handoff;
  items: HandoffItem[];
  supplements: TimelineEvent[];
}

export interface FieldConflict {
  field: string;
  current: unknown;
  attempted: unknown;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    currentVersion?: number;
    conflicts?: FieldConflict[];
  };
}

export const STATUS_LABEL: Record<ActionItemStatus, string> = {
  open: '待处理',
  in_progress: '处理中',
  done: '已完成',
  verified: '已核实',
};

export const KIND_LABEL: Record<TimelineEvent['kind'], string> = {
  evidence: '证据',
  supplement: '补充',
  audit: '审计',
};
