import { useLayoutEffect, useRef, useState } from "react";
import type {
  SupplementalDiff,
  SnapshotData,
  ActionItem,
  Acknowledgement,
  ItemType,
  FieldConflict,
} from "../types";
import { formatDateTime, kindLabel, statusLabel } from "../format";
import { ConflictAlert } from "./ConflictAlert";
import { useToast } from "../toast";
import { api } from "../api";

interface Props {
  parentSnapshot: SnapshotData;
  diff: SupplementalDiff;
  supplementalHandoffId: string;
  acknowledgements: Acknowledgement[];
  liveActionItems: ActionItem[];
  actor: string;
  onChanged: () => void | Promise<void>;
}

const FOCUS_STORAGE_KEY = "supplemental-ack-focus";

function fieldLabel(field: string): string {
  switch (field) {
    case "title":
      return "标题";
    case "detail":
      return "详情";
    case "status":
      return "状态";
    case "responsible_party":
      return "责任方";
    case "occurred_at":
      return "发生时间";
    default:
      return field;
  }
}

function display(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") {
    if (["open", "in_progress", "blocked", "done"].includes(v)) {
      return statusLabel(v);
    }
    if (Number.isNaN(Date.parse(v)) === false && v.includes("T")) {
      return formatDateTime(v);
    }
    return v;
  }
  return JSON.stringify(v);
}

interface AckTarget {
  type: ItemType;
  id: string;
  version: number | null;
}

export function SupplementalDiffView({
  parentSnapshot,
  diff,
  supplementalHandoffId,
  acknowledgements,
  liveActionItems,
  actor,
  onChanged,
}: Props) {
  const { notify } = useToast();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    key: string;
    message: string;
    currentVersion: number;
    conflicts: FieldConflict[];
  } | null>(null);

  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const restoringRef = useRef(true);
  const focusTargetRef = useRef<string | null>(
    typeof sessionStorage !== "undefined"
      ? sessionStorage.getItem(FOCUS_STORAGE_KEY)
      : null,
  );

  const ackMap = new Map(
    acknowledgements.map((a) => [`${a.item_type}:${a.item_id}`, a]),
  );

  const liveVersionMap = new Map(liveActionItems.map((a) => [a.id, a.version]));

  useLayoutEffect(() => {
    if (!restoringRef.current) return;
    const target = focusTargetRef.current;
    if (!target) {
      restoringRef.current = false;
      return;
    }
    const el = btnRefs.current[target];
    if (el) {
      restoringRef.current = false;
      el.scrollIntoView({ block: "nearest" });
      el.focus();
      sessionStorage.removeItem(FOCUS_STORAGE_KEY);
    }
  });

  async function acknowledge(target: AckTarget, title: string) {
    if (!actor) {
      notify("请先在右上角填写当前值班人", "err");
      return;
    }
    const key = `${target.type}:${target.id}`;
    setPendingKey(key);
    setConflict(null);
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(FOCUS_STORAGE_KEY, key);
    }
    try {
      const r = await api.acknowledgeSupplemental(supplementalHandoffId, {
        item_type: target.type,
        item_id: target.id,
        acknowledged_by: actor,
        expected_version: target.version ?? undefined,
      });
      notify(
        r.replayed
          ? `「${title}」已确认过，无需重复`
          : `已确认补充包项「${title}」`,
        r.replayed ? "info" : "ok",
      );
      await onChanged();
      requestAnimationFrame(() => {
        btnRefs.current[key]?.focus();
      });
    } catch (e) {
      const err = e as {
        status?: number;
        conflict?: {
          message: string;
          currentVersion: number;
          conflicts: FieldConflict[];
        };
      };
      if (err.status === 409 && err.conflict) {
        setConflict({
          key,
          message: err.conflict.message,
          currentVersion: err.conflict.currentVersion,
          conflicts: err.conflict.conflicts,
        });
        notify("确认版本已过期，请查看字段级当前值", "err");
      } else {
        notify(e instanceof Error ? e.message : "确认失败", "err");
      }
    } finally {
      setPendingKey(null);
    }
  }

  function renderAckButton(target: AckTarget, title: string) {
    const key = `${target.type}:${target.id}`;
    const ack = ackMap.get(key);
    const isPending = pendingKey === key;
    return (
      <div className="actions" style={{ marginTop: 6 }}>
        <button
          ref={(el) => {
            btnRefs.current[key] = el;
          }}
          className={ack ? "ghost" : "primary"}
          onClick={() => acknowledge(target, title)}
          disabled={isPending}
          aria-pressed={Boolean(ack)}
          aria-label={`确认补充包项 ${title}`}
        >
          {ack
            ? `已确认（由 ${ack.acknowledged_by}${ack.acked_version ? ` · v${ack.acked_version}` : ""}）`
            : isPending
              ? "确认中..."
              : "确认该项"}
        </button>
      </div>
    );
  }

  return (
    <div className="diff-grid">
      <div className="diff-col">
        <h4>父包快照（签收时固化，不可变）</h4>
        <div className="muted">
          签收于 {formatDateTime(parentSnapshot.captured_at)}
        </div>
        {parentSnapshot.action_items.map((a) => (
          <div className="diff-item" key={a.id}>
            <div className="title">{a.title}</div>
            <div className="meta">
              {statusLabel(a.status)} · {a.responsible_party} · v{a.version}
            </div>
          </div>
        ))}
        {parentSnapshot.timeline_events.map((t) => (
          <div className="diff-item" key={t.id}>
            <div className="title">{kindLabel(t.kind)}</div>
            <div className="meta">{formatDateTime(t.occurred_at)}</div>
          </div>
        ))}
      </div>

      <div className="diff-col diff-changes">
        <h4>签收后差异（补充包快照）</h4>
        <div className="muted">生成于 {formatDateTime(diff.generated_at)}</div>

        {diff.added_action_items.length === 0 &&
          diff.changed_action_items.length === 0 &&
          diff.added_timeline_events.length === 0 && (
            <div className="muted">签收后无新增或变化。</div>
          )}

        {diff.added_action_items.length > 0 && (
          <>
            <div className="diff-section-title">新增行动项</div>
            {diff.added_action_items.map((a) => {
              const key = `action_item:${a.id}`;
              return (
                <div className="diff-item added" key={a.id}>
                  <div className="title">＋ {a.title}</div>
                  <div className="meta">
                    {statusLabel(a.status)} · {a.responsible_party} · {a.id} ·
                    当前 v{liveVersionMap.get(a.id) ?? a.version}
                  </div>
                  {conflict?.key === key && (
                    <ConflictAlert
                      message={conflict.message}
                      currentVersion={conflict.currentVersion}
                      conflicts={conflict.conflicts}
                      onReload={async () => {
                        setConflict(null);
                        await onChanged();
                        requestAnimationFrame(() => {
                          btnRefs.current[key]?.focus();
                        });
                      }}
                    />
                  )}
                  {renderAckButton(
                    {
                      type: "action_item",
                      id: a.id,
                      version: liveVersionMap.get(a.id) ?? a.version,
                    },
                    a.title,
                  )}
                </div>
              );
            })}
          </>
        )}

        {diff.changed_action_items.length > 0 && (
          <>
            <div className="diff-section-title">变化行动项（逐字段）</div>
            {diff.changed_action_items.map((c) => {
              const base = parentSnapshot.action_items.find(
                (a) => a.id === c.id,
              );
              const key = `action_item:${c.id}`;
              return (
                <div className="diff-item changed" key={c.id}>
                  <div className="title">
                    ~ {c.title}{" "}
                    <span className="version-tag">
                      v{c.from_version}→v{c.to_version}
                    </span>
                  </div>
                  <table className="field-diff">
                    <tbody>
                      {Object.entries(c.changes).map(([field, change]) => (
                        <tr key={field}>
                          <th>{fieldLabel(field)}</th>
                          <td className="from">{display(change.from)}</td>
                          <td className="arrow">→</td>
                          <td className="to">{display(change.to)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="meta">
                    父包原值：{base ? statusLabel(base.status) : "—"} · 当前 v
                    {liveVersionMap.get(c.id) ?? c.to_version}
                  </div>
                  {conflict?.key === key && (
                    <ConflictAlert
                      message={conflict.message}
                      currentVersion={conflict.currentVersion}
                      conflicts={conflict.conflicts}
                      onReload={async () => {
                        setConflict(null);
                        await onChanged();
                        requestAnimationFrame(() => {
                          btnRefs.current[key]?.focus();
                        });
                      }}
                    />
                  )}
                  {renderAckButton(
                    {
                      type: "action_item",
                      id: c.id,
                      version: liveVersionMap.get(c.id) ?? c.to_version,
                    },
                    c.title,
                  )}
                </div>
              );
            })}
          </>
        )}

        {diff.added_timeline_events.length > 0 && (
          <>
            <div className="diff-section-title">新增时间线事件</div>
            {diff.added_timeline_events.map((t) => {
              const key = `timeline_event:${t.id}`;
              return (
                <div className="diff-item added" key={t.id}>
                  <div className="title">＋ {kindLabel(t.kind)}</div>
                  <div className="meta">
                    {t.description} · {formatDateTime(t.occurred_at)}
                  </div>
                  {conflict?.key === key && (
                    <ConflictAlert
                      message={conflict.message}
                      currentVersion={conflict.currentVersion}
                      conflicts={conflict.conflicts}
                      onReload={async () => {
                        setConflict(null);
                        await onChanged();
                        requestAnimationFrame(() => {
                          btnRefs.current[key]?.focus();
                        });
                      }}
                    />
                  )}
                  {renderAckButton(
                    { type: "timeline_event", id: t.id, version: null },
                    t.description,
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
