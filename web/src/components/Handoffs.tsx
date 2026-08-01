import { useState } from 'react';
import { api, ApiError, fmtTime } from '../api';
import type { Handoff, HandoffDetail } from '../types';

export function Handoffs({
  incidentId,
  handoffs,
  selectedId,
  detail,
  onSelect,
  onChanged,
  announce,
}: {
  incidentId: string;
  handoffs: Handoff[];
  selectedId: string | null;
  detail: HandoffDetail | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  announce: (msg: string) => void;
}) {
  const [createForm, setCreateForm] = useState({
    fromShift: '',
    toShift: '',
    note: '',
    createdBy: '',
  });
  const [signedBy, setSignedBy] = useState('');
  const [confirmedBy, setConfirmedBy] = useState('');
  const [supp, setSupp] = useState({ title: '', detail: '', owner: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suppKey, setSuppKey] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.message}（${err.body.code}）`
          : '操作失败';
      setError(msg);
      announce(`操作失败：${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const createHandoff = () =>
    run(async () => {
      const res = await api.post<{ handoff: Handoff }>(
        `/api/incidents/${incidentId}/handoffs`,
        createForm,
        crypto.randomUUID(),
      );
      announce(`交接包 ${res.handoff.id} 已创建（草稿）`);
      onSelect(res.handoff.id);
      onChanged();
    });

  const sign = () =>
    run(async () => {
      if (!detail) return;
      await api.post(
        `/api/handoffs/${detail.handoff.id}/sign`,
        { signedBy, expectedVersion: detail.handoff.version },
        crypto.randomUUID(),
      );
      announce(`交接包 ${detail.handoff.id} 已签收，快照已锁定`);
      onChanged();
    });

  const confirm = (itemId: string) =>
    run(async () => {
      if (!detail) return;
      const res = await api.post<{ alreadyConfirmed: boolean }>(
        `/api/handoffs/${detail.handoff.id}/items/${itemId}/confirm`,
        { confirmedBy },
        crypto.randomUUID(),
      );
      announce(
        res.alreadyConfirmed ? `「${itemId}」此前已确认（幂等重放）` : `已确认「${itemId}」`,
      );
      onChanged();
    });

  const addSupplement = () =>
    run(async () => {
      if (!detail) return;
      const key = suppKey ?? crypto.randomUUID();
      setSuppKey(key);
      await api.post(`/api/handoffs/${detail.handoff.id}/supplements`, supp, key);
      setSupp({ title: '', detail: '', owner: '' });
      setSuppKey(null);
      announce('补充事件已追加并关联原交接包');
      onChanged();
    });

  const h = detail?.handoff;

  return (
    <section aria-labelledby="handoffs-heading">
      <h2 id="handoffs-heading">交接包</h2>

      <div className="card">
        <h3>新建交接包</h3>
        <div className="field-row">
          <label>
            交班班次
            <input
              data-focus-id="ho-create-from"
              value={createForm.fromShift}
              onChange={(e) => setCreateForm({ ...createForm, fromShift: e.target.value })}
            />
          </label>
          <label>
            接班班次
            <input
              data-focus-id="ho-create-to"
              value={createForm.toShift}
              onChange={(e) => setCreateForm({ ...createForm, toShift: e.target.value })}
            />
          </label>
          <label>
            备注
            <input
              data-focus-id="ho-create-note"
              value={createForm.note}
              onChange={(e) => setCreateForm({ ...createForm, note: e.target.value })}
            />
          </label>
          <label>
            创建人
            <input
              data-focus-id="ho-create-by"
              value={createForm.createdBy}
              onChange={(e) => setCreateForm({ ...createForm, createdBy: e.target.value })}
            />
          </label>
          <button
            data-focus-id="ho-create-submit"
            disabled={busy || !createForm.fromShift || !createForm.toShift || !createForm.createdBy}
            onClick={createHandoff}
          >
            创建
          </button>
        </div>
      </div>

      <ul className="chip-list" aria-label="交接包列表">
        {handoffs.map((ho) => (
          <li key={ho.id}>
            <button
              className={`chip ${ho.id === selectedId ? 'chip-active' : ''}`}
              data-focus-id={`ho-chip-${ho.id}`}
              aria-pressed={ho.id === selectedId}
              onClick={() => onSelect(ho.id === selectedId ? null : ho.id)}
            >
              {ho.from_shift} → {ho.to_shift}（{ho.status === 'signed' ? '已签收' : '草稿'}）
            </button>
          </li>
        ))}
      </ul>

      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}

      {h && detail && (
        <div className="card" data-testid={`handoff-${h.id}`}>
          <div className="card-head">
            <h3>
              {h.from_shift} → {h.to_shift}
            </h3>
            <span className={`badge ${h.status === 'signed' ? 'status-verified' : ''}`}>
              {h.status === 'signed' ? '已签收（不可修改）' : '草稿'}
            </span>
            <span className="mono muted">{h.id}</span>
            <span className="muted">v{h.version}</span>
          </div>
          {h.note && <div>备注:{h.note}</div>}
          <div className="muted">
            创建 {fmtTime(h.created_at)}（{h.created_by}）
            {h.signed_at && ` ・ 签收 ${fmtTime(h.signed_at)}`}
          </div>

          {h.status === 'draft' && (
            <div className="field-row">
              <label>
                签收人
                <input
                  data-focus-id="ho-sign-by"
                  value={signedBy}
                  onChange={(e) => setSignedBy(e.target.value)}
                />
              </label>
              <button data-focus-id="ho-sign" disabled={busy || !signedBy} onClick={sign}>
                签收并锁定快照
              </button>
              <span className="muted">签收后交接包不可修改，后续变化只能追加补充事件</span>
            </div>
          )}

          {h.status === 'signed' && (
            <div className="field-row">
              <label>
                接班人（确认用）
                <input
                  data-focus-id="ho-confirm-by"
                  value={confirmedBy}
                  onChange={(e) => setConfirmedBy(e.target.value)}
                />
              </label>
            </div>
          )}

          <h4>{h.status === 'signed' ? '签收快照（逐项确认）' : '当前行动项（签收时生成快照）'}</h4>
          <ul className="card-list">
            {detail.items.map((item) => (
              <li key={item.id} className="card" data-testid={`ho-item-${item.id}`}>
                <div className="card-head">
                  <strong>{item.title}</strong>
                  <span className="mono muted">{item.id}</span>
                </div>
                <div className="muted">
                  责任方 {item.owner} ・ 签收时状态 {item.status_at_sign} ・ v
                  {item.version_at_sign}
                </div>
                {h.status === 'signed' &&
                  (item.confirmed ? (
                    <div className="confirmed">
                      ✓ 已由 {item.confirmed_by} 确认（
                      {item.confirmed_at ? fmtTime(item.confirmed_at) : ''}）
                    </div>
                  ) : (
                    <button
                      data-focus-id={`ho-confirm-${item.id}`}
                      disabled={busy || !confirmedBy}
                      onClick={() => confirm(item.id)}
                    >
                      确认
                    </button>
                  ))}
              </li>
            ))}
          </ul>

          {h.status === 'signed' && (
            <>
              <h4>追加补充事件（关联本交接包）</h4>
              <div className="field-row">
                <label>
                  标题
                  <input
                    data-focus-id="supp-title"
                    value={supp.title}
                    onChange={(e) => setSupp({ ...supp, title: e.target.value })}
                  />
                </label>
                <label>
                  详情
                  <input
                    data-focus-id="supp-detail"
                    value={supp.detail}
                    onChange={(e) => setSupp({ ...supp, detail: e.target.value })}
                  />
                </label>
                <label>
                  报告人
                  <input
                    data-focus-id="supp-owner"
                    value={supp.owner}
                    onChange={(e) => setSupp({ ...supp, owner: e.target.value })}
                  />
                </label>
                <button
                  data-focus-id="supp-submit"
                  disabled={busy || !supp.title || !supp.owner}
                  onClick={addSupplement}
                >
                  追加
                </button>
              </div>
              {detail.supplements.length > 0 && (
                <ul className="card-list">
                  {detail.supplements.map((s) => (
                    <li key={s.id} className="muted">
                      [{fmtTime(s.occurred_at)}] {s.title} — {s.owner}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
