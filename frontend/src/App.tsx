import { useEffect, useMemo, useState } from "react";
import { ActorBar } from "./components/ActorBar";
import { IncidentHeader } from "./components/IncidentHeader";
import { ActionItemList } from "./components/ActionItemList";
import { TimelineList } from "./components/TimelineList";
import { HandoffPanel } from "./components/HandoffPanel";
import { useIncidentLive } from "./hooks/useIncidentLive";
import { useActor } from "./hooks/useActor";
import { api } from "./api";
import type { Acknowledgement } from "./types";
import { ToastProvider } from "./toast";

const DEFAULT_INCIDENT = "inc-gd-20260729-01";

export function App() {
  const [actor, setActor] = useActor();
  const [incidentId, setIncidentId] = useState(DEFAULT_INCIDENT);
  const [draftId, setDraftId] = useState(DEFAULT_INCIDENT);
  const { data, loading, error, connection, refetch, lastUpdated } =
    useIncidentLive(incidentId);
  const [acks, setAcks] = useState<Acknowledgement[]>([]);

  const latestSigned = useMemo(() => {
    if (!data) return null;
    const signed = data.handoffs.filter((h) => h.status === "signed");
    return signed[signed.length - 1] ?? null;
  }, [data]);

  useEffect(() => {
    if (!latestSigned) {
      setAcks([]);
      return;
    }
    let cancelled = false;
    api
      .getHandoff(latestSigned.id)
      .then((d) => {
        if (!cancelled) setAcks(d.acknowledgements);
      })
      .catch(() => {
        if (!cancelled) setAcks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [latestSigned]);

  const acknowledgedIds = useMemo(
    () => new Set(acks.map((a) => a.item_id)),
    [acks]
  );

  const signedVersions = useMemo(() => {
    const map: Record<string, number> = {};
    if (latestSigned?.snapshot) {
      for (const a of latestSigned.snapshot.action_items) {
        map[a.id] = a.version;
      }
    }
    return map;
  }, [latestSigned]);

  function submitIncidentId(e: React.FormEvent) {
    e.preventDefault();
    if (draftId.trim()) setIncidentId(draftId.trim());
  }

  return (
    <ToastProvider>
      <div className="app">
        <div className="topbar">
          <h1>应急事件跨班次交接系统</h1>
          <ActorBar actor={actor} setActor={setActor} />
        </div>

        <form onSubmit={submitIncidentId} className="form-row" style={{ marginBottom: 16 }}>
          <label htmlFor="incident-id" className="muted">
            事件 ID
          </label>
          <input
            id="incident-id"
            value={draftId}
            onChange={(e) => setDraftId(e.target.value)}
            style={{ minWidth: 280 }}
            aria-label="事件 ID"
          />
          <button type="submit">加载</button>
        </form>

        {loading && !data && <div className="panel">加载中...</div>}
        {error && <div className="panel toast err">{error}</div>}

        {data && (
          <>
            <IncidentHeader
              incident={data.incident}
              connection={connection}
              lastUpdated={lastUpdated}
              onRefresh={refetch}
            />

            <div className="grid">
              <section className="panel" aria-label="行动项">
                <h2>行动项</h2>
                <ActionItemList
                  incidentId={data.incident.id}
                  items={data.action_items}
                  actor={actor}
                  acknowledgedIds={acknowledgedIds}
                  signedVersions={signedVersions}
                  onChanged={refetch}
                />
              </section>

              <section className="panel" aria-label="证据时间线">
                <h2>证据时间线</h2>
                <TimelineList
                  events={data.timeline_events}
                  incidentId={data.incident.id}
                  actor={actor}
                  acknowledgedIds={acknowledgedIds}
                  onChanged={refetch}
                />
              </section>
            </div>

            <section className="panel" aria-label="交接与签收">
              <h2>交接包与逐项签收</h2>
              <HandoffPanel
                incidentId={data.incident.id}
                handoffs={data.handoffs}
                actor={actor}
                onChanged={refetch}
              />
            </section>
          </>
        )}
      </div>
    </ToastProvider>
  );
}
