import { useRef, useState } from "react";
import { api } from "../api";
import type { ActionItem, ActionItemStatus } from "../types";
import { formatDateTime, statusLabel } from "../format";
import { ConflictAlert } from "./ConflictAlert";
import { useToast } from "../toast";

interface Props {
  items: ActionItem[];
  actor: string;
  acknowledgedIds: Set<string>;
  signedVersions: Record<string, number>;
  onChanged: () => void | Promise<void>;
}

const STATUSES: ActionItemStatus[] = ["open", "in_progress", "blocked", "done"];

export function ActionItemList({
  items,
  actor,
  acknowledgedIds,
  signedVersions,
  onChanged,
}: Props) {
  const { notify } = useToast();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    id: string;
    message: string;
    currentVersion: number;
    conflicts: { field: string; base: unknown; current: unknown; attempted: unknown }[];
  } | null>(null);
  const selectRefs = useRef<Record<string, HTMLSelectElement | null>>({});

  async function changeStatus(item: ActionItem, next: ActionItemStatus) {
    if (next === item.status) return;
    if (!actor) {
      notify("请先在右上角填写当前值班人", "err");
      return;
    }
    setPendingId(item.id);
    setConflict(null);
    try {
      await api.patchActionItem(item.id, item.version, { status: next }, actor);
      notify(`行动项「${item.title}」已更新为${statusLabel(next)}`, "ok");
      await onChanged();
      requestAnimationFrame(() => {
        selectRefs.current[item.id]?.focus();
      });
    } catch (e) {
      const err = e as { status?: number; conflict?: typeof conflict };
      if (err.status === 409 && err.conflict) {
        setConflict({
          id: item.id,
          message: err.conflict.message,
          currentVersion: err.conflict.currentVersion,
          conflicts: err.conflict.conflicts,
        });
        notify("状态已被他人修改，请处理冲突", "err");
      } else {
        notify(e instanceof Error ? e.message : "更新失败", "err");
      }
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div>
      {items.map((item) => {
        const isAcked = acknowledgedIds.has(item.id);
        const signedVersion = signedVersions[item.id];
        const changedAfterSign =
          signedVersion !== undefined && item.version > signedVersion;
        return (
          <div className="item" key={item.id}>
            <div className="row">
              <div>
                <div className="title">
                  <span
                    className={`ack-dot ${isAcked ? "yes" : "no"}`}
                    title={isAcked ? "已逐项确认" : "未确认"}
                    aria-label={isAcked ? "已确认" : "未确认"}
                  />{" "}
                  {item.title}
                </div>
                <div className="meta">
                  {item.id} · 责任方：{item.responsible_party} · 发生：
                  {formatDateTime(item.occurred_at)}
                  {changedAfterSign && (
                    <span className="badge" style={{ marginLeft: 8 }}>
                      签收后变更 v{signedVersion}→v{item.version}
                    </span>
                  )}
                </div>
              </div>
              <div className="actions">
                <span className="version-tag">v{item.version}</span>
                <label className="sr-only" htmlFor={`status-${item.id}`}>
                  行动项状态
                </label>
                <select
                  id={`status-${item.id}`}
                  className="status-select"
                  ref={(el) => {
                    selectRefs.current[item.id] = el;
                  }}
                  value={item.status}
                  disabled={pendingId === item.id}
                  onChange={(e) =>
                    changeStatus(item, e.target.value as ActionItemStatus)
                  }
                  aria-label={`${item.title} 状态`}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {statusLabel(s)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {conflict?.id === item.id && (
              <ConflictAlert
                message={conflict.message}
                currentVersion={conflict.currentVersion}
                conflicts={conflict.conflicts}
                onReload={async () => {
                  setConflict(null);
                  await onChanged();
                  requestAnimationFrame(() => {
                    selectRefs.current[item.id]?.focus();
                  });
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
