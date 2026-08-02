import { useEffect, useState } from 'react';
import type { ApiClient } from './api';
import type { Handoff, HandoffDetail } from './types';

interface Props {
  api: ApiClient;
  handoffs: Handoff[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (from: string, to: string, summary: string) => Promise<void>;
  onChanged: () => void;
  onToast: (msg: string, kind?: 'ok' | 'err') => void;
}

export function HandoffPanel({ api, handoffs, selectedId, onSelect, onCreate, onChanged, onToast }: Props) {
  const [detail, setDetail] = useState<HandoffDetail | null>(null);
  const [from, setFrom] = useState('白班 08:00-20:00');
  const [to, setTo] = useState('夜班 20:00-08:00');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api.getHandoff(selectedId).then((d) => {
      if (!cancelled) setDetail(d);
    }).catch(() => {
      if (!cancelled) setDetail(null);
    });
    return () => {
      cancelled = true;
    };
  }, [api, selectedId, handoffs.length]);

  async function create() {
    setBusy(true);
    try {
      await onCreate(from, to, summary);
      setSummary('');
      onToast('交接包已创建并生成快照', 'ok');
    } catch (e) {
      onToast(e instanceof Error ? e.message : '创建失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function ackItem(actionItemId: string) {
    if (!detail) return;
    setBusy(true);
    try {
      await api.acknowledgeItem(detail.handoff.handoff_id, actionItemId, '逐项确认');
      onToast('已逐项确认', 'ok');
      onChanged();
      const d = await api.getHandoff(detail.handoff.handoff_id);
      setDetail(d);
    } catch (e) {
      onToast(e instanceof Error ? e.message : '确认失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function signOff() {
    if (!detail) return;
    setBusy(true);
    try {
      await api.acknowledgePackage(detail.handoff.handoff_id, '签收交接包');
      onToast('交接包已签收，快照已冻结', 'ok');
      onChanged();
      const d = await api.getHandoff(detail.handoff.handoff_id);
      setDetail(d);
    } catch (e) {
      onToast(e instanceof Error ? e.message : '签收失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  const acked = (actionItemId: string | null) =>
    detail?.acknowledgments.some((a) => a.action_item_id === actionItemId && a.confirmed_by === api.actor);

  return (
    <div>
      <div className="add-form" style={{ marginBottom: 12 }}>
        <input value={from} onChange={(e) => setFrom(e.target.value)} aria-label="交班班次" placeholder="交班班次" />
        <input value={to} onChange={(e) => setTo(e.target.value)} aria-label="接班班次" placeholder="接班班次" />
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="交接摘要"
          aria-label="交接摘要"
          style={{ flex: 1, minWidth: 160, background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '6px 8px' }}
        />
        <button onClick={create} disabled={busy}>生成交接快照</button>
      </div>

      <ul className="clean" style={{ marginBottom: 12 }}>
        {handoffs.map((h) => (
          <li
            key={h.handoff_id}
            className={`handoff-item ${h.handoff_id === selectedId ? 'active' : ''}`}
            tabIndex={0}
            role="button"
            aria-pressed={h.handoff_id === selectedId}
            onClick={() => onSelect(h.handoff_id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(h.handoff_id);
              }
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <strong>{h.handoff_id}</strong>
              <span className={`badge badge-${h.status}`}>{h.status === 'acknowledged' ? '已签收' : '待签收'}</span>
            </div>
            <div className="ai-meta">
              {h.from_shift} → {h.to_shift} · {h.created_by} · {fmt(h.created_at)}
            </div>
            {h.acknowledged_by && (
              <div className="ai-meta">签收人：{h.acknowledged_by} · {fmt(h.acknowledged_at!)}</div>
            )}
          </li>
        ))}
        {handoffs.length === 0 && <li className="ai-meta">尚无交接包</li>}
      </ul>

      {detail && (
        <div className="handoff-detail panel" style={{ background: 'var(--bg)' }}>
          <div className="snap-note">
            以下为创建时的不可变快照。签收后行动项状态变化会显示在“签收后补充”中，原快照不会被修改。
          </div>
          <h3 style={{ fontSize: 14, marginTop: 0 }}>快照行动项</h3>
          <ul className="clean">
            {detail.items.map((it) => {
              const isAcked = acked(it.action_item_id);
              return (
                <li key={it.handoff_item_id} className="ack-row">
                  <div>
                    <div style={{ fontSize: 13 }}>{it.title}</div>
                    <div className="ack-who">
                      {it.owner} · 快照状态 {it.status} · 快照版本 v{it.snapshot_version}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {isAcked && <span className="badge badge-done">已确认</span>}
                    <button
                      className="secondary"
                      onClick={() => ackItem(it.action_item_id)}
                      disabled={busy || detail.handoff.status === 'acknowledged' && !isAcked ? false : isAcked}
                      data-testid={`ack-${it.action_item_id}`}
                    >
                      {isAcked ? '已确认（幂等）' : '逐项确认'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <h3 style={{ fontSize: 14 }}>快照时间线（{detail.timeline.length}）</h3>
          <ul className="clean">
            {detail.timeline.map((t) => (
              <li key={t.event_id} className="tl-summary" style={{ fontSize: 12, padding: '2px 0' }}>
                {t.summary} <span className="ack-who">— {t.actor}</span>
              </li>
            ))}
          </ul>

          {detail.supplementary.length > 0 && (
            <>
              <h3 style={{ fontSize: 14, color: 'var(--warn)' }}>签收后补充（{detail.supplementary.length}）</h3>
              <ul className="clean">
                {detail.supplementary.map((s) => (
                  <li key={s.supplementary_id} className="timeline-item supp">
                    <div className="tl-summary">{s.summary}</div>
                    <div className="tl-meta">{s.actor} · {fmt(s.occurred_at)} · {s.change_type}</div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div style={{ marginTop: 12 }}>
            {detail.handoff.status === 'pending' ? (
              <button onClick={signOff} disabled={busy} data-testid="signoff-btn">
                签收交接包（{detail.handoff.to_shift}）
              </button>
            ) : (
              <div className="badge badge-acknowledged">已签收，快照冻结</div>
            )}
          </div>
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
