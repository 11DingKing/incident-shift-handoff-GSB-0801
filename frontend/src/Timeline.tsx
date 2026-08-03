import { useState } from 'react';
import type { TimelineEvent as TL } from './types';

interface Props {
  events: TL[];
  onAdd: (summary: string, eventType: string) => Promise<void>;
  readOnly?: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  road_closure: '道路封闭',
  evidence_ingested: '证据入库',
  update: '进展更新',
};

export function Timeline({ events, onAdd, readOnly }: Props) {
  const [summary, setSummary] = useState('');
  const [type, setType] = useState('update');
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!summary.trim()) return;
    setSaving(true);
    try {
      await onAdd(summary.trim(), type);
      setSummary('');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <ul className="clean">
        {events.map((ev) => (
          <li key={ev.event_id} className="timeline-item">
            <div className="tl-summary">
              <span className="badge">{TYPE_LABELS[ev.event_type] ?? ev.event_type}</span>{' '}
              {ev.summary}
            </div>
            <div className="tl-meta">
              {ev.actor} · {fmt(ev.occurred_at)} · <span className="version-tag">v{ev.version}</span>
            </div>
          </li>
        ))}
      </ul>
      {!readOnly && (
        <div className="add-form">
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="事件类型">
            <option value="update">进展更新</option>
            <option value="road_closure">道路封闭</option>
            <option value="evidence_ingested">证据入库</option>
          </select>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="追加一条时间线（补充事件）…"
            aria-label="时间线内容"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
            }}
          />
          <button onClick={submit} disabled={saving || !summary.trim()}>追加</button>
        </div>
      )}
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
