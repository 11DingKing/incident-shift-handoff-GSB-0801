import type {
  ActionItem,
  ActionItemStatus,
  ConflictField,
  Handoff,
  HandoffDetail,
  Incident,
  TimelineEvent,
} from './types';
import { ApiError } from './types';

export interface ApiClientOptions {
  baseUrl?: string;
  actor: string;
}

export class ApiClient {
  private baseUrl: string;
  actor: string;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = (opts.baseUrl ?? '').replace(/\/$/, '');
    this.actor = opts.actor;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // HTTP headers must be ISO-8859-1; encode the actor (which may contain CJK) safely.
    const encodedActor = encodeURIComponent(this.actor);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Actor': encodedActor,
      ...(init.headers as Record<string, string> | undefined),
    };
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const text = await res.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      const conflictFields: ConflictField[] | undefined = body?.conflictFields;
      throw new ApiError(res.status, body?.error || `request failed ${res.status}`, conflictFields);
    }
    return body as T;
  }

  getIncident(incidentId: string): Promise<Incident> {
    return this.request(`/api/incidents/${incidentId}`);
  }

  listActionItems(incidentId: string): Promise<ActionItem[]> {
    return this.request(`/api/incidents/${incidentId}/action-items`);
  }

  listTimeline(incidentId: string): Promise<TimelineEvent[]> {
    return this.request(`/api/incidents/${incidentId}/timeline`);
  }

  listHandoffs(incidentId: string): Promise<Handoff[]> {
    return this.request(`/api/incidents/${incidentId}/handoffs`);
  }

  getHandoff(handoffId: string): Promise<HandoffDetail> {
    return this.request(`/api/handoffs/${handoffId}`);
  }

  createHandoff(incidentId: string, payload: {
    handoff_id?: string;
    from_shift: string;
    to_shift: string;
    summary: string;
  }): Promise<HandoffDetail> {
    return this.request(`/api/incidents/${incidentId}/handoffs`, {
      method: 'POST',
      body: JSON.stringify({ created_by: this.actor, ...payload }),
    });
  }

  updateActionItem(
    actionItemId: string,
    patch: { status?: ActionItemStatus; title?: string; owner?: string; expected_version: number },
  ): Promise<ActionItem> {
    return this.request(`/api/action-items/${actionItemId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  addTimelineEvent(incidentId: string, payload: {
    event_id?: string;
    event_type: string;
    summary: string;
    occurred_at?: string;
  }): Promise<TimelineEvent> {
    return this.request(`/api/incidents/${incidentId}/timeline`, {
      method: 'POST',
      body: JSON.stringify({ actor: this.actor, occurred_at: new Date().toISOString(), ...payload }),
    });
  }

  createSupplementaryHandoff(incidentId: string, payload: {
    parent_handoff_id: string;
    from_shift: string;
    to_shift: string;
    summary: string;
    idempotency_key?: string;
  }): Promise<HandoffDetail & { created: boolean }> {
    const idempotency_key =
      payload.idempotency_key ?? `${this.actor}:${payload.parent_handoff_id}:supplementary`;
    return this.request(`/api/incidents/${incidentId}/handoffs/supplementary`, {
      method: 'POST',
      body: JSON.stringify({ created_by: this.actor, ...payload, idempotency_key }),
    });
  }

  acknowledgeItem(
    handoffId: string,
    actionItemId: string,
    note: string,
    expectedVersion?: number,
  ): Promise<unknown> {
    const idempotency_key = `${this.actor}:${handoffId}:item:${actionItemId}`;
    return this.request(`/api/handoffs/${handoffId}/items/${actionItemId}/acknowledge`, {
      method: 'POST',
      body: JSON.stringify({ confirmed_by: this.actor, note, idempotency_key, expected_version: expectedVersion }),
    });
  }

  acknowledgePackage(
    handoffId: string,
    note: string,
    expectedVersion?: number,
  ): Promise<unknown> {
    const idempotency_key = `${this.actor}:${handoffId}:package`;
    return this.request(`/api/handoffs/${handoffId}/acknowledge`, {
      method: 'POST',
      body: JSON.stringify({ confirmed_by: this.actor, note, idempotency_key, expected_version: expectedVersion }),
    });
  }
}
