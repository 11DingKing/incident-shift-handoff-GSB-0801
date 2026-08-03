import { useEffect, useState } from 'react';
import { api, ApiError, fmtTime } from '../api';
import {
  STATUS_LABEL,
  type ActionItem,
  type ActionItemStatus,
  type FieldConflict,
} from '../types';

interface EditState {
  title: string;
  owner: string;
  status: ActionItemStatus;
  baseVersion: number;
  dirty: boolean;
  saving: boolean;
  conflict: { currentVersion: number; conflicts: FieldConflict[] } | null;
  error: string | null;
  idemKey: string | null;
}

function fromServer(item: ActionItem): EditState {
  return {
    title: item.title,
    owner: item.owner,
    status: item.status,
    baseVersion: item.version,
    dirty: false,
    saving: false,
    conflict: null,
    error: null,
    idemKey: null,
  };
}

export function ActionItems({
  items,
  onChanged,
  announce,
}: {
  items: ActionItem[];
  onChanged: () => void;
  announce: (msg: string) => void;
}) {
  const [edits, setEdits] = useState<Record<string, EditState>>({});

  // 轮询收敛：未在编辑中的行跟随服务器最新状态；编辑中的行不被覆盖
  useEffect(() => {
    setEdits((prev) => {
      const next = { ...prev };
      for (const item of items) {
        const cur = next[item.id];
        if (!cur || !cur.dirty) {
          next[item.id] = { ...fromServer(item), conflict: cur?.conflict ?? null };
        } else if (!cur.conflict && item.version !== cur.baseVersion) {
          // 他人已改：保持我的输入，但提示存在新版本
          next[item.id] = cur;
        }
      }
      return next;
    });
  }, [items]);

  const update = (id: string, patch: Partial<EditState>) =>
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const save = async (item: ActionItem, forceVersion?: number) => {
    const edit = edits[item.id];
    if (!edit || edit.saving) return;
    const key = edit.idemKey ?? crypto.randomUUID();
    update(item.id, { saving: true, error: null, idemKey: key });
    try {
      await api.patch(`/api/action-items/${item.id}`, {
        title: edit.title,
        owner: edit.owner,
        status: edit.status,
        expectedVersion: forceVersion ?? edit.baseVersion,
        updatedBy: edit.owner,
      }, key);
      update(item.id, { saving: false, dirty: false, conflict: null, idemKey: null });
      announce(`已保存「${edit.title}」`);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body.conflicts) {
        update(item.id, {
          saving: false,
          conflict: { currentVersion: err.body.currentVersion!, conflicts: err.body.conflicts },
        });
        announce(`保存「${edit.title}」失败：版本冲突，请处理字段级冲突`);
      } else {
        const msg = err instanceof ApiError ? err.message : '保存失败';
        update(item.id, { saving: false, error: msg });
        announce(`保存失败：${msg}`);
      }
    }
  };

  return (
    <section aria-labelledby="items-heading">
      <h2 id="items-heading">行动项</h2>
      <ul className="card-list">
        {items.map((item) => {
          const edit = edits[item.id] ?? fromServer(item);
          return (
            <li key={item.id} className="card" data-testid={`item-${item.id}`}>
              <div className="card-head">
                <span className="mono">{item.id}</span>
                <span className={`badge status-${edit.status}`}>
                  {STATUS_LABEL[edit.status]}
                </span>
                <span className="muted">v{edit.baseVersion}</span>
              </div>
              <div className="field-row">
                <label>
                  标题
                  <input
                    data-focus-id={`item-title-${item.id}`}
                    value={edit.title}
                    onChange={(e) => update(item.id, { title: e.target.value, dirty: true })}
                  />
                </label>
                <label>
                  责任方
                  <input
                    data-focus-id={`item-owner-${item.id}`}
                    value={edit.owner}
                    onChange={(e) => update(item.id, { owner: e.target.value, dirty: true })}
                  />
                </label>
                <label>
                  状态
                  <select
                    data-focus-id={`item-status-${item.id}`}
                    value={edit.status}
                    onChange={(e) =>
                      update(item.id, {
                        status: e.target.value as ActionItemStatus,
                        dirty: true,
                      })
                    }
                  >
                    {Object.entries(STATUS_LABEL).map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  data-focus-id={`item-save-${item.id}`}
                  disabled={!edit.dirty || edit.saving}
                  onClick={() => save(item)}
                >
                  {edit.saving ? '保存中…' : '保存'}
                </button>
              </div>
              <div className="muted">
                发生时间 {fmtTime(item.occurred_at)} ・ 更新于 {fmtTime(item.updated_at)}
              </div>
              {edit.error && (
                <div role="alert" className="error">
                  {edit.error}
                  <button data-focus-id={`item-retry-${item.id}`} onClick={() => save(item)}>
                    重试
                  </button>
                </div>
              )}
              {edit.conflict && (
                <div role="alert" className="conflict">
                  <strong>版本冲突（服务器当前 v{edit.conflict.currentVersion}）：</strong>
                  <ul>
                    {edit.conflict.conflicts.map((c) => (
                      <li key={c.field}>
                        字段 <code>{c.field}</code>：当前值「{String(c.current)}」≠ 你提交的「
                        {String(c.attempted)}」
                      </li>
                    ))}
                  </ul>
                  <button
                    data-focus-id={`item-force-${item.id}`}
                    onClick={() => save(item, edit.conflict!.currentVersion)}
                  >
                    基于最新版本强制保存
                  </button>
                  <button
                    data-focus-id={`item-discard-${item.id}`}
                    onClick={() => {
                      update(item.id, { ...fromServer(item) });
                      announce(`已放弃修改并加载「${item.title}」最新值`);
                    }}
                  >
                    放弃修改，加载最新
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
