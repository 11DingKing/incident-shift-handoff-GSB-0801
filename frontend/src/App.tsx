import { useCallback, useMemo, useRef, useState } from 'react';
import { ApiClient } from './api';
import { useIncidentData } from './useIncidentData';
import { ActionItemCard } from './ActionItemCard';
import { Timeline } from './Timeline';
import { HandoffPanel } from './HandoffPanel';
import type { ActionItem } from './types';

const INCIDENT_ID = 'inc-gd-20260729-01';

interface Toast { id: number; msg: string; kind: 'ok' | 'err'; }

export default function App() {
  const [actor, setActor] = useState(() => localStorage.getItem('actor') || '接班-值班员');
  const client = useMemo(() => new ApiClient({ actor }), [actor]);
  const data = useIncidentData(client, INCIDENT_ID, 2000);
  const [selectedHandoff, setSelectedHandoff] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const actorInput = useRef<HTMLInputElement>(null);

  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  function commitActor() {
    const v = actorInput.current?.value.trim();
    if (v) {
      setActor(v);
      localStorage.setItem('actor', v);
      toast(`已切换身份为 ${v}`, 'ok');
    }
  }

  function onItemUpdated(updated: ActionItem) {
    // Optimistically apply; next poll will reconcile and converge to server state.
    data.actionItems.splice(
      0, data.actionItems.length,
      ...data.actionItems.map((it) => (it.action_item_id === updated.action_item_id ? updated : it)),
    );
    void data.refresh();
  }

  async function addTimeline(summary: string, eventType: string) {
    await client.addTimelineEvent(INCIDENT_ID, { event_type: eventType, summary });
    await data.refresh();
  }

  async function createHandoff(fromShift: string, toShift: string, sum: string) {
    const d = await client.createHandoff(INCIDENT_ID, {
      from_shift: fromShift, to_shift: toShift, summary: sum,
    });
    await data.refresh();
    setSelectedHandoff(d.handoff.handoff_id);
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>应急事件交接系统</h1>
          <div className="incident-meta">
            <span className="live-dot" />实时收敛中 · 轮询间隔 2s
          </div>
        </div>
        <div className="actor-bar">
          <label htmlFor="actor-input">当前值班员</label>
          <input
            id="actor-input"
            ref={actorInput}
            defaultValue={actor}
            onKeyDown={(e) => { if (e.key === 'Enter') commitActor(); }}
          />
          <button className="secondary" onClick={commitActor}>切换</button>
        </div>
      </header>

      {data.loading && <div className="panel">加载中…</div>}
      {data.error && <div className="panel conflict-box">加载失败：{data.error}</div>}

      {data.incident && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <h2 className="incident-title">{data.incident.title}</h2>
          <div className="incident-meta">
            <span className="badge">{data.incident.incident_id}</span> {data.incident.severity} · 发生于 {fmt(data.incident.occurred_at)}
          </div>
          <p className="incident-desc">{data.incident.description}</p>
        </section>
      )}

      <div className="layout">
        <section className="panel">
          <h2>行动项（乐观锁 v{data.actionItems.length}）</h2>
          <ul className="clean">
            {data.actionItems.map((item) => (
              <ActionItemCard
                key={item.action_item_id}
                item={item}
                api={client}
                onUpdated={onItemUpdated}
                onToast={toast}
              />
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2>证据时间线</h2>
          <Timeline events={data.timeline} onAdd={addTimeline} />
        </section>

        <section className="panel" style={{ gridColumn: '1 / -1' }}>
          <h2>交接包（快照 · 逐项确认 · 签收）</h2>
          <HandoffPanel
            api={client}
            handoffs={data.handoffs}
            selectedId={selectedHandoff}
            onSelect={setSelectedHandoff}
            onCreate={createHandoff}
            onChanged={data.refresh}
            onToast={toast}
          />
        </section>
      </div>

      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role="status">{t.msg}</div>
      ))}
    </div>
  );
}

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}
