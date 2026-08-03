import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClient } from './api';
import type { ActionItem, Handoff, Incident, TimelineEvent } from './types';

export interface IncidentView {
  incident: Incident | null;
  actionItems: ActionItem[];
  timeline: TimelineEvent[];
  handoffs: Handoff[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Polls the incident's action items, timeline, and handoffs on an interval.
 *
 * Real-time convergence: when a concurrent client changes data on the server,
 * the next poll fetches the new authoritative state. Local optimistic edits are
 * always reconciled against server versions (the server returns 409 field-level
 * conflicts on stale versions), so the UI never silently overwrites remote work.
 */
export function useIncidentData(
  client: ApiClient,
  incidentId: string,
  intervalMs = 2500,
): IncidentView {
  const [incident, setIncident] = useState<Incident | null>(null);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [inc, items, tl, hs] = await Promise.all([
        client.getIncident(incidentId),
        client.listActionItems(incidentId),
        client.listTimeline(incidentId),
        client.listHandoffs(incidentId),
      ]);
      if (!mounted.current) return;
      setIncident(inc);
      setActionItems(items);
      setTimeline(tl);
      setHandoffs(hs);
      setError(null);
    } catch (e: any) {
      if (mounted.current) setError(e.message ?? String(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [client, incidentId]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [refresh, intervalMs]);

  return { incident, actionItems, timeline, handoffs, loading, error, refresh };
}
