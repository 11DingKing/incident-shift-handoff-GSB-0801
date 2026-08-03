import type {
  IncidentDetail,
  Handoff,
  HandoffDetail,
  ActionItem,
  TimelineEvent,
  SupplementalEvent,
  SupplementalHandoff,
  OptimisticLockConflict,
} from "./types";

function idempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function request<T>(
  path: string,
  options: RequestInit & { idempotencyKey?: string } = {},
): Promise<T> {
  const { idempotencyKey: customKey, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers);
  if (!headers.has("Content-Type") && fetchOptions.body) {
    headers.set("Content-Type", "application/json");
  }
  if (
    fetchOptions.method &&
    fetchOptions.method !== "GET" &&
    !headers.has("Idempotency-Key")
  ) {
    headers.set("Idempotency-Key", customKey ?? idempotencyKey());
  }
  const res = await fetch(path, { ...fetchOptions, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const err = new Error(
      (body.message as string) ?? `请求失败 (${res.status})`,
    ) as Error & {
      status: number;
      body: Record<string, unknown>;
      conflict?: OptimisticLockConflict;
    };
    err.status = res.status;
    err.body = body;
    if (res.status === 409 && body.error === "optimistic_lock_conflict") {
      err.conflict = body as unknown as OptimisticLockConflict;
    }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  getIncident(id: string): Promise<IncidentDetail> {
    return request<IncidentDetail>(`/api/incidents/${encodeURIComponent(id)}`);
  },

  patchActionItem(
    id: string,
    expectedVersion: number,
    patch: Partial<{
      title: string;
      detail: string;
      status: string;
      responsible_party: string;
      occurred_at: string;
    }>,
    actor: string,
  ): Promise<{ action_item: ActionItem; supplemental_event_id?: string }> {
    return request(`/api/action-items/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion, patch, actor }),
    });
  },

  addTimeline(
    incidentId: string,
    input: {
      id?: string;
      kind: string;
      description: string;
      responsible_party: string;
      occurred_at?: string;
      actor: string;
    },
  ): Promise<TimelineEvent> {
    return request(
      `/api/incidents/${encodeURIComponent(incidentId)}/timeline`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },

  createActionItem(
    incidentId: string,
    input: {
      id?: string;
      title: string;
      detail?: string;
      status?: string;
      responsible_party: string;
      occurred_at?: string;
      actor: string;
    },
  ): Promise<{ action_item: ActionItem; replayed: boolean }> {
    return request(
      `/api/incidents/${encodeURIComponent(incidentId)}/action-items`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },

  createHandoff(
    incidentId: string,
    input: {
      from_shift: string;
      to_shift: string;
      summary: string;
      created_by: string;
    },
  ): Promise<Handoff> {
    return request(
      `/api/incidents/${encodeURIComponent(incidentId)}/handoffs`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },

  getHandoff(id: string): Promise<HandoffDetail> {
    return request<HandoffDetail>(`/api/handoffs/${encodeURIComponent(id)}`);
  },

  signHandoff(id: string, actor: string): Promise<Handoff> {
    return request(`/api/handoffs/${encodeURIComponent(id)}/sign`, {
      method: "POST",
      body: JSON.stringify({ actor }),
    });
  },

  acknowledge(
    handoffId: string,
    input: {
      item_type: "action_item" | "timeline_event";
      item_id: string;
      acknowledged_by: string;
      note?: string;
    },
  ): Promise<{ acknowledgement: { id: string }; replayed: boolean }> {
    return request(
      `/api/handoffs/${encodeURIComponent(handoffId)}/acknowledgements`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },

  acknowledgeSupplemental(
    supplementalHandoffId: string,
    input: {
      item_type: "action_item" | "timeline_event";
      item_id: string;
      acknowledged_by: string;
      note?: string;
      expected_version?: number;
    },
    idempotencyKey?: string,
  ): Promise<{ acknowledgement: { id: string }; replayed: boolean }> {
    return request(
      `/api/supplemental-handoffs/${encodeURIComponent(supplementalHandoffId)}/acknowledgements`,
      {
        method: "POST",
        body: JSON.stringify(input),
        idempotencyKey,
      },
    );
  },

  appendSupplemental(
    handoffId: string,
    input: {
      kind: string;
      description: string;
      responsible_party: string;
      occurred_at?: string;
      actor: string;
    },
  ): Promise<SupplementalEvent> {
    return request(
      `/api/handoffs/${encodeURIComponent(handoffId)}/supplemental-events`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },

  createSupplementalHandoff(
    handoffId: string,
    actor: string,
    summary?: string,
  ): Promise<SupplementalHandoff> {
    return request(
      `/api/handoffs/${encodeURIComponent(handoffId)}/supplemental-handoff`,
      {
        method: "POST",
        body: JSON.stringify({ actor, summary }),
      },
    );
  },
};
