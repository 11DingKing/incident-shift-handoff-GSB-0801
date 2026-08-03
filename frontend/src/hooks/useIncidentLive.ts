import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { IncidentDetail } from "../types";

export type ConnectionState = "connecting" | "open" | "polling" | "closed";

export interface UseIncidentLiveResult {
  data: IncidentDetail | null;
  loading: boolean;
  error: string | null;
  connection: ConnectionState;
  refetch: () => Promise<void>;
  lastUpdated: Date | null;
}

export function useIncidentLive(incidentId: string): UseIncidentLiveResult {
  const [data, setData] = useState<IncidentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const safetyRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const detail = await api.getIncident(incidentId);
      if (!mountedRef.current) return;
      setData(detail);
      setError(null);
      setLastUpdated(new Date());
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [incidentId]);

  const scheduleRefetch = useCallback(() => {
    if (pendingRef.current) clearTimeout(pendingRef.current);
    pendingRef.current = setTimeout(() => {
      void fetchData();
    }, 180);
  }, [fetchData]);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);

    const stopSafety = () => {
      if (safetyRef.current) {
        clearInterval(safetyRef.current);
        safetyRef.current = null;
      }
    };
    const stopPolling = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    const closeSse = () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };

    const startPolling = () => {
      closeSse();
      stopPolling();
      setConnection("polling");
      pollRef.current = setInterval(() => {
        void fetchData();
      }, 3000);
    };

    const connect = () => {
      closeSse();
      setConnection("connecting");
      const es = new EventSource(
        `/api/incidents/${encodeURIComponent(incidentId)}/events`
      );
      esRef.current = es;
      es.onopen = () => {
        if (!mountedRef.current) return;
        setConnection("open");
        stopPolling();
      };
      es.onmessage = scheduleRefetch;
      es.addEventListener("action_item.updated", scheduleRefetch);
      es.addEventListener("timeline.created", scheduleRefetch);
      es.addEventListener("handoff.created", scheduleRefetch);
      es.addEventListener("handoff.signed", scheduleRefetch);
      es.addEventListener("acknowledgement.created", scheduleRefetch);
      es.addEventListener("supplemental_event.created", scheduleRefetch);
      es.addEventListener("supplemental_handoff.created", scheduleRefetch);
      es.onerror = () => {
        if (!mountedRef.current) return;
        startPolling();
      };
    };

    void fetchData().then(() => {
      if (!mountedRef.current) return;
      connect();
      safetyRef.current = setInterval(() => {
        void fetchData();
      }, 10000);
    });

    return () => {
      mountedRef.current = false;
      closeSse();
      stopPolling();
      stopSafety();
      if (pendingRef.current) clearTimeout(pendingRef.current);
      setConnection("closed");
    };
  }, [incidentId, fetchData, scheduleRefetch]);

  return {
    data,
    loading,
    error,
    connection,
    refetch: fetchData,
    lastUpdated,
  };
}
