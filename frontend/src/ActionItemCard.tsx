import { useEffect, useRef, useState } from 'react';
import type { ActionItem, ActionItemStatus, ConflictField } from './types';
import { ApiError } from './types';

const STATUS_LABELS: Record<ActionItemStatus, string> = {
  open: '待处理',
  in_progress: '进行中',
  done: '已完成',
  blocked: '受阻',
};

interface Props {
  item: ActionItem;
  api: { updateActionItem: (id: string, patch: any) => Promise<ActionItem> };
  onUpdated: (item: ActionItem) => void;
  onToast: (msg: string, kind?: 'ok' | 'err') => void;
}

export function ActionItemCard({ item, api, onUpdated, onToast }: Props) {
  const [status, setStatus] = useState<ActionItemStatus>(item.status);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ConflictField[] | null>(null);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);

  // If the server-pushed item changes (e.g. another client updated it), reconcile.
  useEffect(() => {
    setStatus(item.status);
    setConflict(null);
  }, [item.status, item.version]);

  async function save(next: ActionItemStatus) {
    if (next === item.status) return;
    setSaving(true);
    setConflict(null);
    try {
      const updated = await api.updateActionItem(item.action_item_id, {
        status: next,
        expected_version: item.version,
      });
      setStatus(updated.status);
      onUpdated(updated);
      onToast(`「${item.title}」已更新为 ${STATUS_LABELS[updated.status]}`, 'ok');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.conflictFields) {
        setConflict(e.conflictFields);
        setConflictVersion(e.conflictFields[0]?.current_version ?? null);
        setStatus(item.status); // revert local select to server-known value
        onToast(`状态已被他人修改，请处理冲突`, 'err');
        // restore focus to the select for keyboard users
        setTimeout(() => selectRef.current?.focus(), 0);
      } else {
        onToast(e instanceof Error ? e.message : '更新失败', 'err');
        setStatus(item.status);
      }
    } finally {
      setSaving(false);
    }
  }

  function rebaseAndRetry() {
    if (!conflictVersion) return;
    // After rebasing, we retry with the current server version. In a real app we'd
    // show a merge UI; here we simply adopt the server state and let the user re-apply.
    setConflict(null);
    onToast('已载入最新版本，请重新选择状态', 'ok');
    setTimeout(() => selectRef.current?.focus(), 0);
  }

  return (
    <li className="action-item" tabIndex={0} aria-label={`行动项 ${item.title}`}>
      <div className="ai-head">
        <span className="ai-title">{item.title}</span>
        <span className={`badge badge-${item.status}`}>{STATUS_LABELS[item.status]}</span>
      </div>
      <div className="ai-desc">{item.description}</div>
      <div className="ai-meta">
        责任方：{item.owner} · 提出时间：{fmt(item.occurred_at)}
        {item.due_at ? ` · 期限：${fmt(item.due_at)}` : ''}
        {' '}
        <span className="version-tag" title="乐观版本号">v{item.version}</span>
      </div>
      <div className="ai-controls">
        <label htmlFor={`status-${item.action_item_id}`} className="sr-only">
          更新状态
        </label>
        <select
          id={`status-${item.action_item_id}`}
          ref={selectRef}
          data-testid={`status-${item.action_item_id}`}
          value={status}
          disabled={saving}
          onChange={(e) => {
            const next = e.target.value as ActionItemStatus;
            setStatus(next);
            save(next);
          }}
        >
          {(Object.keys(STATUS_LABELS) as ActionItemStatus[]).map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
        {saving && <span className="ai-meta">保存中…</span>}
      </div>

      {conflict && (
        <div className="conflict-box" role="alert" data-testid="conflict-box">
          <strong>字段级冲突（旧版本 v{item.version}）</strong>
          <div className="hint">
            该行动项已被其他值班员更新至 v{conflictVersion}。你的修改未被写入，避免静默覆盖。
          </div>
          <table>
            <thead>
              <tr><th>字段</th><th>你提交的</th><th>服务器当前值</th></tr>
            </thead>
            <tbody>
              {conflict.map((f) => (
                <tr key={f.field}>
                  <td>{labelOf(f.field)}</td>
                  <td>{String(f.submitted)}</td>
                  <td>{String(f.current)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8 }}>
            <button onClick={rebaseAndRetry} data-testid="rebase-btn">载入最新版本并重试</button>
          </div>
        </div>
      )}
    </li>
  );
}

function labelOf(field: string): string {
  const map: Record<string, string> = {
    status: '状态',
    title: '标题',
    owner: '责任方',
    due_at: '期限',
    description: '描述',
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
