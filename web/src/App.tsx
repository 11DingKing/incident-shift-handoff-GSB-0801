import { useCallback, useEffect, useState } from 'react';
import { api, fmtTime } from './api';
import { ActionItems } from './components/ActionItems';
import { Handoffs } from './components/Handoffs';
import { Timeline } from './components/Timeline';
import { useFocusRestore } from './focus';
import type { HandoffDetail, Overview, TimelineEvent } from './types';

const INCIDENT_ID = 'inc-gd-20260729-01';
const POLL_MS = 3000;

export default function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [selectedHandoff, setSelectedHandoff] = useState<string | null>(null);
  const [detail, setDetail] = useState<HandoffDetail | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const refresh = useCallback(async () => {
    const [ov, tl] = await Promise.all([
      api.get<Overview>(`/api/incidents/${INCIDENT_ID}`),
      api.get<{ events: TimelineEvent[] }>(`/api/incidents/${INCIDENT_ID}/timeline`),
    ]);
    setOverview(ov);
    setEvents(tl.events);
    if (selectedHandoff) {
      try {
        setDetail(await api.get<HandoffDetail>(`/api/handoffs/${selectedHandoff}`));
      } catch {
        setDetail(null);
      }
    }
    setLastSync(new Date());
  }, [selectedHandoff]);

  // 轮询：两个浏览器会话的操作最终都会收敛到一致视图
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  useFocusRestore([overview, events, detail]);

  if (!overview) return <p>加载中…</p>;

  return (
    <main>
      <div aria-live="polite" className="sr-only" data-testid="announcer">
        {announcement}
      </div>
      <header>
        <h1>{overview.incident.title}</h1>
        <div className="muted">
          事件号 <span className="mono">{overview.incident.id}</span> ・ 状态{' '}
          {overview.incident.status}
          {lastSync && <> ・ 最后同步 {fmtTime(lastSync.toISOString())}</>}
        </div>
      </header>

      <div className="grid">
        <div>
          <ActionItems
            items={overview.actionItems}
            onChanged={refresh}
            announce={setAnnouncement}
          />
          <Handoffs
            incidentId={overview.incident.id}
            handoffs={overview.handoffs}
            selectedId={selectedHandoff}
            detail={detail}
            onSelect={setSelectedHandoff}
            onChanged={refresh}
            announce={setAnnouncement}
          />
        </div>
        <Timeline events={events} onOpenHandoff={setSelectedHandoff} />
      </div>
    </main>
  );
}
