import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { ActionItem, ConflictBody, Handoff, IncidentBundle } from './types';

const INCIDENT_ID = 'inc-gd-20260729-01';
const POLL_MS = 3000;

const STATUS_LABELS: Record<string, string> = {
  open: '待处理',
  in_progress: '进行中',
  blocked: '受阻',
  done: '已完成',
};

/** A monotonically-unique idempotency key for a client action. */
function newKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function App() {
  const [bundle, setBundle] = useState<IncidentBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operator, setOperator] = useState('接班人');
  const [live, setLive] = useState('');
  // Restore focus to whatever element id was active before a re-render / refetch.
  const restoreFocusRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getIncident(INCIDENT_ID);
      setBundle(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Initial load + real-time convergence via polling.
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // After each render, restore focus if an action requested it.
  useEffect(() => {
    if (restoreFocusRef.current) {
      const el = document.getElementById(restoreFocusRef.current);
      el?.focus();
      restoreFocusRef.current = null;
    }
  });

  const announce = (msg: string) => setLive(msg);

  if (error && !bundle) {
    return (
      <main className="app">
        <p role="alert" className="error">
          加载失败：{error}
        </p>
        <button onClick={() => void refresh()}>重试</button>
      </main>
    );
  }

  if (!bundle) {
    return (
      <main className="app">
        <p aria-busy="true">加载中…</p>
      </main>
    );
  }

  return (
    <main className="app">
      <header>
        <h1>应急事件交接系统</h1>
        <p className="incident-title" data-testid="incident-title">
          {bundle.incident.title}（{bundle.incident.id}）
        </p>
        <label className="operator">
          当前操作人：
          <input
            aria-label="当前操作人"
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
          />
        </label>
        <button onClick={() => void refresh()} data-testid="refresh">
          刷新
        </button>
      </header>

      {/* Screen-reader + test hook live region for eventual convergence messages */}
      <div aria-live="polite" className="sr-live" data-testid="live-region">
        {live}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <ActionItemsSection
        bundle={bundle}
        operator={operator}
        onChanged={refresh}
        announce={announce}
        restoreFocusRef={restoreFocusRef}
      />

      <TimelineSection bundle={bundle} />

      <HandoffSection
        bundle={bundle}
        operator={operator}
        onChanged={refresh}
        announce={announce}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Action items
// ---------------------------------------------------------------------------

function ActionItemsSection(props: {
  bundle: IncidentBundle;
  operator: string;
  onChanged: () => Promise<void>;
  announce: (msg: string) => void;
  restoreFocusRef: React.MutableRefObject<string | null>;
}) {
  const { bundle, operator, onChanged, announce, restoreFocusRef } = props;
  const [conflicts, setConflicts] = useState<Record<string, ConflictBody>>({});

  const changeStatus = async (item: ActionItem, status: string) => {
    const controlId = `status-${item.id}`;
    restoreFocusRef.current = controlId; // remember focus for restoration after refetch
    try {
      await api.updateActionItem(bundle.incident.id, item.id, {
        expected_version: item.version,
        status,
        actor: operator,
      });
      setConflicts((c) => {
        const next = { ...c };
        delete next[item.id];
        return next;
      });
      announce(`行动项「${item.title}」已更新为${STATUS_LABELS[status]}`);
      await onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.conflict) {
        // Show a field-level conflict instead of silently overwriting.
        setConflicts((c) => ({ ...c, [item.id]: err.conflict! }));
        announce(`行动项「${item.title}」发生版本冲突，请查看最新状态`);
        await onChanged();
      } else {
        announce(`更新失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  return (
    <section aria-labelledby="action-items-h">
      <h2 id="action-items-h">行动项</h2>
      <ul className="items">
        {bundle.action_items.map((item) => {
          const conflict = conflicts[item.id];
          return (
            <li key={item.id} className="item" data-testid={`action-item-${item.id}`}>
              <div className="item-head">
                <span className="item-title">{item.title}</span>
                <span
                  className={`badge status-${item.status}`}
                  data-testid={`action-status-${item.id}`}
                >
                  {STATUS_LABELS[item.status]}
                </span>
                <span className="version" data-testid={`action-version-${item.id}`}>
                  v{item.version}
                </span>
              </div>
              <div className="item-meta">
                责任方：{item.responsible_party} ｜ 发生时间：
                {new Date(item.occurred_at).toLocaleString('zh-CN')}
              </div>
              <label className="control">
                更新状态：
                <select
                  id={`status-${item.id}`}
                  data-testid={`status-select-${item.id}`}
                  value={item.status}
                  onChange={(e) => void changeStatus(item, e.target.value)}
                >
                  {Object.entries(STATUS_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {conflict && (
                <div
                  role="alert"
                  className="conflict"
                  data-testid={`conflict-${item.id}`}
                >
                  版本冲突：期望 v{conflict.expected_version}，当前 v{conflict.actual_version}。
                  {Object.entries(conflict.conflicts).map(([field, info]) => (
                    <div key={field} data-testid={`conflict-field-${item.id}-${field}`}>
                      字段「{field}」最新值：{String(info.current)}
                    </div>
                  ))}
                  <button
                    data-testid={`conflict-dismiss-${item.id}`}
                    onClick={() =>
                      setConflicts((c) => {
                        const next = { ...c };
                        delete next[item.id];
                        return next;
                      })
                    }
                  >
                    我已了解最新状态
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function TimelineSection({ bundle }: { bundle: IncidentBundle }) {
  return (
    <section aria-labelledby="timeline-h">
      <h2 id="timeline-h">证据时间线</h2>
      <ol className="timeline">
        {bundle.timeline_events.map((ev) => (
          <li key={ev.id} data-testid={`timeline-${ev.id}`}>
            <span className="badge">{ev.kind}</span> {ev.description}
            <div className="item-meta">
              责任方：{ev.responsible_party} ｜ 发生：
              {new Date(ev.occurred_at).toLocaleString('zh-CN')} ｜ 入库：
              {new Date(ev.recorded_at).toLocaleString('zh-CN')}
              {ev.evidence_uri ? ` ｜ 证据：${ev.evidence_uri}` : ''}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Handoffs
// ---------------------------------------------------------------------------

function HandoffSection(props: {
  bundle: IncidentBundle;
  operator: string;
  onChanged: () => Promise<void>;
  announce: (msg: string) => void;
}) {
  const { bundle, operator, onChanged, announce } = props;
  const [creating, setCreating] = useState(false);
  const [fromShift, setFromShift] = useState('早班');
  const [toShift, setToShift] = useState('晚班');
  const [summary, setSummary] = useState('本班已完成主路封闭，绕行路线待复核。');

  const create = async () => {
    setCreating(true);
    try {
      await api.createHandoff(bundle.incident.id, {
        from_shift: fromShift,
        to_shift: toShift,
        summary,
        created_by: operator,
      });
      announce('已创建交接草稿');
      await onChanged();
    } catch (err) {
      announce(`创建失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <section aria-labelledby="handoff-h">
      <h2 id="handoff-h">交接包</h2>
      <form
        className="handoff-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label>
          交出班次
          <input value={fromShift} onChange={(e) => setFromShift(e.target.value)} aria-label="交出班次" />
        </label>
        <label>
          接入班次
          <input value={toShift} onChange={(e) => setToShift(e.target.value)} aria-label="接入班次" />
        </label>
        <label className="wide">
          摘要
          <textarea value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="交接摘要" />
        </label>
        <button type="submit" disabled={creating} data-testid="create-handoff">
          {creating ? '创建中…' : '创建交接草稿'}
        </button>
      </form>

      {bundle.handoffs.map((h) => (
        <HandoffCard
          key={h.id}
          handoff={h}
          bundle={bundle}
          operator={operator}
          onChanged={onChanged}
          announce={announce}
        />
      ))}
    </section>
  );
}

function HandoffCard(props: {
  handoff: Handoff;
  bundle: IncidentBundle;
  operator: string;
  onChanged: () => Promise<void>;
  announce: (msg: string) => void;
}) {
  const { handoff, bundle, operator, onChanged, announce } = props;
  const [busy, setBusy] = useState(false);
  // A stable idempotency key per mounted card so retries reuse the same key.
  const signKeyRef = useRef(newKey('sign'));

  const signOff = async () => {
    setBusy(true);
    try {
      await api.signOff(
        bundle.incident.id,
        handoff.id,
        { signed_off_by: operator, expected_version: handoff.version },
        signKeyRef.current,
      );
      announce('交接已签收，快照已冻结');
      await onChanged();
    } catch (err) {
      announce(`签收失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const ackKeys = useRef<Map<string, string>>(new Map());
  const acknowledge = async (itemType: 'action_item' | 'timeline_event', itemId: string) => {
    const mapKey = `${itemType}:${itemId}`;
    if (!ackKeys.current.has(mapKey)) ackKeys.current.set(mapKey, newKey('ack'));
    setBusy(true);
    try {
      const res = await api.acknowledge(
        handoff.id,
        { item_type: itemType, item_id: itemId, acknowledged_by: operator },
        ackKeys.current.get(mapKey)!,
      );
      announce(res.duplicate ? '该项已确认（重复提交已忽略）' : '已确认该项');
      await onChanged();
    } catch (err) {
      announce(`确认失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const ackedIds = new Set(handoff.acknowledgements.map((a) => `${a.item_type}:${a.item_id}`));
  const signed = handoff.status === 'signed';
  const snapshotItems = signed && handoff.snapshot ? handoff.snapshot.action_items : bundle.action_items;
  const snapshotTimeline =
    signed && handoff.snapshot ? handoff.snapshot.timeline_events : bundle.timeline_events;

  return (
    <article className="handoff-card" data-testid={`handoff-${handoff.id}`}>
      <div className="handoff-head">
        <span>
          {handoff.from_shift} → {handoff.to_shift}
        </span>
        <span
          className={`badge ${signed ? 'status-done' : ''}`}
          data-testid={`handoff-status-${handoff.id}`}
        >
          {signed ? '已签收' : '草稿'}
        </span>
      </div>
      <p className="summary">{handoff.summary}</p>
      {signed && (
        <p className="signed-meta" data-testid={`handoff-signed-${handoff.id}`}>
          签收人：{handoff.signed_off_by} ｜ 签收时间：
          {handoff.signed_off_at ? new Date(handoff.signed_off_at).toLocaleString('zh-CN') : ''}
          （快照已冻结，不可修改）
        </p>
      )}

      {!signed && (
        <button onClick={() => void signOff()} disabled={busy} data-testid={`sign-off-${handoff.id}`}>
          签收此交接包
        </button>
      )}

      <div className="ack-block">
        <h3>逐项确认{signed ? '' : '（签收后仍需逐项确认，未确认不会自动关闭）'}</h3>
        <ul className="items">
          {snapshotItems.map((item) => {
            const key = `action_item:${item.id}`;
            const done = ackedIds.has(key);
            return (
              <li key={item.id} data-testid={`ack-action-${handoff.id}-${item.id}`}>
                <span>{item.title}</span>{' '}
                <span className="badge">{STATUS_LABELS[item.status]}</span>{' '}
                {done ? (
                  <span className="badge status-done" data-testid={`acked-action-${handoff.id}-${item.id}`}>
                    已确认
                  </span>
                ) : (
                  <button
                    disabled={busy || !signed}
                    data-testid={`ack-btn-action-${handoff.id}-${item.id}`}
                    onClick={() => void acknowledge('action_item', item.id)}
                  >
                    确认
                  </button>
                )}
              </li>
            );
          })}
          {snapshotTimeline.map((ev) => {
            const key = `timeline_event:${ev.id}`;
            const done = ackedIds.has(key);
            return (
              <li key={ev.id} data-testid={`ack-timeline-${handoff.id}-${ev.id}`}>
                <span>{ev.description}</span>{' '}
                {done ? (
                  <span className="badge status-done" data-testid={`acked-timeline-${handoff.id}-${ev.id}`}>
                    已确认
                  </span>
                ) : (
                  <button
                    disabled={busy || !signed}
                    data-testid={`ack-btn-timeline-${handoff.id}-${ev.id}`}
                    onClick={() => void acknowledge('timeline_event', ev.id)}
                  >
                    确认
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {signed && (
        <SupplementalBlock
          handoff={handoff}
          bundle={bundle}
          operator={operator}
          onChanged={onChanged}
          announce={announce}
        />
      )}
    </article>
  );
}

function SupplementalBlock(props: {
  handoff: Handoff;
  bundle: IncidentBundle;
  operator: string;
  onChanged: () => Promise<void>;
  announce: (msg: string) => void;
}) {
  const { handoff, bundle, operator, onChanged, announce } = props;
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!desc.trim()) return;
    setBusy(true);
    try {
      await api.addSupplemental(bundle.incident.id, handoff.id, {
        kind: 'update',
        description: desc,
        responsible_party: operator,
        occurred_at: new Date().toISOString(),
      });
      setDesc('');
      announce('已追加补充事件并关联原交接包');
      await onChanged();
    } catch (err) {
      announce(`追加失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="supplemental">
      <h3>签收后补充事件（关联原交接包）</h3>
      <ul>
        {handoff.supplemental_events.map((s) => (
          <li key={s.id} data-testid={`supplemental-${handoff.id}-${s.id}`}>
            {s.description}
            <span className="item-meta">
              {' '}
              — {s.responsible_party}，{new Date(s.occurred_at).toLocaleString('zh-CN')}
            </span>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="签收后发生的新变化…"
          aria-label={`为交接包 ${handoff.id} 追加补充事件`}
          data-testid={`supplemental-input-${handoff.id}`}
        />
        <button type="submit" disabled={busy} data-testid={`supplemental-add-${handoff.id}`}>
          追加补充事件
        </button>
      </form>
    </div>
  );
}
