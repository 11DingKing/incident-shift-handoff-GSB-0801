import type {
  Acknowledgement,
  ActionItem,
  ConflictBody,
  Handoff,
  IncidentBundle,
  SupplementalEvent,
  SupplementalHandoff,
  TimelineEvent,
} from './types';

/** Error carrying the parsed body so callers can branch on version_conflict. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(typeof body === 'object' && body && 'message' in body ? String((body as { message: unknown }).message) : `HTTP ${status}`);
    this.name = 'ApiError';
  }

  get conflict(): ConflictBody | null {
    if (
      this.status === 409 &&
      typeof this.body === 'object' &&
      this.body &&
      (this.body as { error?: string }).error === 'version_conflict'
    ) {
      return this.body as ConflictBody;
    }
    return null;
  }
}

async function request<T>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}

export const api = {
  getIncident: (id: string) => request<IncidentBundle>('GET', `/api/incidents/${id}`),

  updateActionItem: (
    incidentId: string,
    itemId: string,
    payload: { expected_version: number; status?: string; title?: string; detail?: string; actor: string },
  ) => request<ActionItem>('PATCH', `/api/incidents/${incidentId}/action-items/${itemId}`, payload),

  createHandoff: (
    incidentId: string,
    payload: { from_shift: string; to_shift: string; summary: string; created_by: string },
  ) => request<Handoff>('POST', `/api/incidents/${incidentId}/handoffs`, payload),

  getHandoff: (handoffId: string) => request<Handoff>('GET', `/api/handoffs/${handoffId}`),

  signOff: (
    incidentId: string,
    handoffId: string,
    payload: { signed_off_by: string; expected_version: number },
    idempotencyKey: string,
  ) =>
    request<Handoff>('POST', `/api/incidents/${incidentId}/handoffs/${handoffId}/sign-off`, payload, {
      'idempotency-key': idempotencyKey,
    }),

  acknowledge: (
    handoffId: string,
    payload: { item_type: 'action_item' | 'timeline_event'; item_id: string; acknowledged_by: string; note?: string },
    idempotencyKey: string,
  ) =>
    request<Acknowledgement & { duplicate: boolean }>(
      'POST',
      `/api/handoffs/${handoffId}/acknowledgements`,
      payload,
      { 'idempotency-key': idempotencyKey },
    ),

  addSupplemental: (
    incidentId: string,
    handoffId: string,
    payload: { kind: string; description: string; responsible_party: string; occurred_at: string },
  ) =>
    request<SupplementalEvent>(
      'POST',
      `/api/incidents/${incidentId}/handoffs/${handoffId}/supplemental`,
      payload,
    ),

  addTimelineEvent: (
    incidentId: string,
    payload: {
      id?: string;
      kind: string;
      description: string;
      responsible_party: string;
      evidence_uri?: string | null;
      occurred_at: string;
      actor: string;
    },
  ) => request<TimelineEvent>('POST', `/api/incidents/${incidentId}/timeline`, payload),

  createActionItem: (
    incidentId: string,
    payload: {
      id?: string;
      title: string;
      detail?: string;
      status?: string;
      responsible_party: string;
      occurred_at: string;
      actor: string;
    },
  ) => request<ActionItem>('POST', `/api/incidents/${incidentId}/action-items`, payload),

  createSupplementalHandoff: (
    incidentId: string,
    parentHandoffId: string,
    payload: { from_shift: string; to_shift: string; summary?: string; created_by: string },
    idempotencyKey: string,
  ) =>
    request<SupplementalHandoff & { duplicate: boolean }>(
      'POST',
      `/api/incidents/${incidentId}/handoffs/${parentHandoffId}/supplemental-handoff`,
      payload,
      { 'idempotency-key': idempotencyKey },
    ),
};
