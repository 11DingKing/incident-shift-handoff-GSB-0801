import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from './api';
import type { Handoff, HandoffDetail, HandoffDiff } from './types';

interface Props {
  api: ApiClient;
  incidentId: string;
  handoffs: Handoff[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (from: string, to: string, summary: string) => Promise<void>;
  onChanged: () => void;
  onToast: (msg: string, kind?: 'ok' | 'err') => void;
}

export function HandoffPanel({ api, incidentId, handoffs, selectedId, onSelect, onCreate, onChanged, onToast }: Props) {
  const [detail, setDetail] = useState<HandoffDetail | null>(null);
  const [parentDetail, setParentDetail] = useState<HandoffDetail | null>(null);
  const [from, setFrom] = useState('白班 08:00-20:00');
  const [to, setTo] = useState('夜班 20:00-08:00');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [suppFrom, setSuppFrom] = useState('夜班 20:00-08:00');
  const [suppTo, setSuppTo] = useState('早班 08:00-14:00');
  const [suppSummary, setSuppSummary] = useState('');
  const lastLoadedId = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setParentDetail(null);
      lastLoadedId.current = null;
      return;
    }
    // Only (re)fetch when the selected package actually changes. Depending on
    // handoffs.length here would cancel an in-flight detail request whenever the
    // polling list refreshes (length changes), which races with onSelect right
    // after creating a supplementary package and could leave the stale parent
    // detail rendered.
    if (lastLoadedId.current === selectedId) return;
    lastLoadedId.current = selectedId;
    let cancelled = false;
    api.getHandoff(selectedId).then(async (d) => {
      if (cancelled) return;
      setDetail(d);
      if (d.handoff.parent_handoff_id) {
        try {
          const p = await api.getHandoff(d.handoff.parent_handoff_id);
          if (!cancelled) setParentDetail(p);
        } catch {
          if (!cancelled) setParentDetail(null);
        }
      } else {
        setParentDetail(null);
      }
    }).catch(() => {
      if (!cancelled) setDetail(null);
    });
    return () => {
      cancelled = true;
    };
  }, [api, selectedId]);

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

  async function createSupplementary() {
    if (!detail || !detail.handoff.handoff_id) return;
    if (detail.handoff.status !== 'acknowledged') {
      onToast('请先签收父交接包，再创建补充包', 'err');
      return;
    }
    setBusy(true);
    try {
      const result = await api.createSupplementaryHandoff(incidentId, {
        parent_handoff_id: detail.handoff.handoff_id,
        from_shift: suppFrom,
        to_shift: suppTo,
        summary: suppSummary,
      });
      onToast(
        result.created ? '补充交接包已创建，仅含新增/变化项及逐字段差异' : '补充包已存在（幂等返回）',
        'ok',
      );
      setSuppSummary('');
      onChanged();
      onSelect(result.handoff.handoff_id);
    } catch (e) {
      onToast(e instanceof Error ? e.message : '创建补充包失败', 'err');
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

  const isSupplementary = detail?.handoff.handoff_kind === 'supplementary';

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
              <strong>
                {h.handoff_kind === 'supplementary' ? '└ 补充包 ' : ''}{h.handoff_id}
              </strong>
              <span className={`badge badge-${h.status}`}>{h.status === 'acknowledged' ? '已签收' : '待签收'}</span>
            </div>
            <div className="ai-meta">
              {h.from_shift} → {h.to_shift} · {h.created_by} · {fmt(h.created_at)}
              {h.parent_handoff_id && ` · 父包 ${h.parent_handoff_id}`}
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
          {isSupplementary ? (
            <SupplementaryView
              detail={detail}
              parent={parentDetail}
              acked={acked}
              onAck={ackItem}
              onSignOff={signOff}
              busy={busy}
            />
          ) : (
            <PrimaryView
              detail={detail}
              acked={acked}
              onAck={ackItem}
              onSignOff={signOff}
              busy={busy}
            />
          )}

          {!isSupplementary && detail.handoff.status === 'acknowledged' && (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <h3 style={{ fontSize: 14, color: 'var(--accent)' }}>创建补充交接包（仅快照新增/变化）</h3>
              <div className="add-form">
                <input value={suppFrom} onChange={(e) => setSuppFrom(e.target.value)} aria-label="补充包交班班次" placeholder="交班班次" />
                <input value={suppTo} onChange={(e) => setSuppTo(e.target.value)} aria-label="补充包接班班次" placeholder="接班班次" />
                <input
                  value={suppSummary}
                  onChange={(e) => setSuppSummary(e.target.value)}
                  placeholder="补充说明"
                  aria-label="补充说明"
                  style={{ flex: 1, minWidth: 160, background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '6px 8px' }}
                />
                <button onClick={createSupplementary} disabled={busy} data-testid="create-supplementary-btn">
                  生成补充包
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PrimaryView({
  detail, acked, onAck, onSignOff, busy,
}: {
  detail: HandoffDetail;
  acked: (id: string | null) => boolean | undefined;
  onAck: (id: string) => void;
  onSignOff: () => void;
  busy: boolean;
}) {
  return (
    <>
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
                  onClick={() => onAck(it.action_item_id)}
                  disabled={busy || !!isAcked}
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
          <button onClick={onSignOff} disabled={busy} data-testid="signoff-btn">
            签收交接包（{detail.handoff.to_shift}）
          </button>
        ) : (
          <div className="badge badge-acknowledged">已签收，快照冻结</div>
        )}
      </div>
    </>
  );
}

function SupplementaryView({
  detail, parent, acked, onAck, onSignOff, busy,
}: {
  detail: HandoffDetail;
  parent: HandoffDetail | null;
  acked: (id: string | null) => boolean | undefined;
  onAck: (id: string) => void;
  onSignOff: () => void;
  busy: boolean;
}) {
  // Group diffs by ref_id for display.
  const diffsByRef = new Map<string, HandoffDiff[]>();
  for (const d of detail.diffs) {
    const arr = diffsByRef.get(d.ref_id) ?? [];
    arr.push(d);
    diffsByRef.set(d.ref_id, arr);
  }

  function parentValue(refId: string, field: string): string {
    if (!parent) return '—';
    const item = parent.items.find((i) => i.action_item_id === refId);
    if (item) return field === '*' ? '（新增项）' : String((item as any)[field] ?? '—');
    const ev = parent.timeline.find((t) => t.event_id === refId);
    if (ev) return '（父包中不存在）';
    return '—';
  }

  return (
    <>
      <div className="snap-note">
        这是补充交接包 <strong>{detail.handoff.handoff_id}</strong>，仅快照父包{' '}
        <strong>{detail.handoff.parent_handoff_id}</strong> 签收后的新增或变化项，旧包的责任人、状态、版本和确认记录保持不变。
      </div>

      <div className="diff-grid" data-testid="diff-grid">
        <div className="diff-col diff-col-parent">
          <h4 style={{ fontSize: 13, color: 'var(--muted)' }}>父快照（不变）</h4>
          {parent ? (
            <ul className="clean">
              {parent.items.map((it) => (
                <li key={it.handoff_item_id} className="diff-cell">
                  <div style={{ fontSize: 12 }}>{it.title}</div>
                  <div className="ack-who">{it.owner} · {it.status} · v{it.snapshot_version}</div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="ack-who">加载父快照…</div>
          )}
        </div>

        <div className="diff-col diff-col-changes">
          <h4 style={{ fontSize: 13, color: 'var(--accent)' }}>
            本次变化（{detail.diffs.length} 个字段差异）
          </h4>
          <ul className="clean">
            {[...diffsByRef.entries()].map(([refId, diffs]) => {
              const snapItem = detail.items.find((i) => i.action_item_id === refId);
              const snapEvent = detail.timeline.find((t) => t.event_id === refId);
              const added = diffs.some((d) => d.change_kind === 'added');
              return (
                <li key={refId} className={`diff-cell ${added ? 'diff-added' : 'diff-modified'}`}
                    data-testid={`diff-${refId}`}>
                  <div style={{ fontSize: 12 }}>
                    {snapItem?.title ?? snapEvent?.summary ?? refId}
                  </div>
                  {diffs.map((d) => (
                    <div key={d.diff_id} className="diff-line" data-field={d.field}>
                      <span className="diff-old">{d.field === '*' ? '新增' : labelOf(d.field)}：{d.old_value ?? parentValue(refId, d.field)}</span>
                      <span className="diff-arrow">→</span>
                      <span className="diff-new">{d.new_value ?? '—'}</span>
                    </div>
                  ))}
                  {snapItem && (
                    <div style={{ marginTop: 6 }}>
                      <button
                        className="secondary"
                        onClick={() => onAck(snapItem.action_item_id)}
                        disabled={busy || !!acked(snapItem.action_item_id)}
                        data-testid={`ack-${snapItem.action_item_id}`}
                      >
                        {acked(snapItem.action_item_id) ? '已确认' : '逐项确认'}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
            {detail.diffs.length === 0 && (
              <li className="ack-who">自父包签收以来没有新增或变化。</li>
            )}
          </ul>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        {detail.handoff.status === 'pending' ? (
          <button onClick={onSignOff} disabled={busy} data-testid="signoff-supp-btn">
            签收补充包（{detail.handoff.to_shift}）
          </button>
        ) : (
          <div className="badge badge-acknowledged">补充包已签收，差异已冻结</div>
        )}
      </div>
    </>
  );
}

function labelOf(field: string): string {
  const map: Record<string, string> = {
    status: '状态',
    title: '标题',
    owner: '责任方',
  };
  return map[field] ?? field;
}

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}
