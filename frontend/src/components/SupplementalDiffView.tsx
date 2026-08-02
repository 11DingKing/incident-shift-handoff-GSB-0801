import type { SupplementalDiff, SnapshotData } from "../types";
import { formatDateTime, kindLabel, statusLabel } from "../format";

interface Props {
  parentSnapshot: SnapshotData;
  diff: SupplementalDiff;
}

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

export function SupplementalDiffView({ parentSnapshot, diff }: Props) {
  const baseActionMap = new Map(
    parentSnapshot.action_items.map((a) => [a.id, a]),
  );
  const baseTimelineIds = new Set(
    parentSnapshot.timeline_events.map((t) => t.id),
  );

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
        <div className="muted">
          生成于 {formatDateTime(diff.generated_at)}
        </div>

        {diff.added_action_items.length === 0 &&
          diff.changed_action_items.length === 0 &&
          diff.added_timeline_events.length === 0 && (
            <div className="muted">签收后无新增或变化。</div>
          )}

        {diff.added_action_items.length > 0 && (
          <>
            <div className="diff-section-title">新增行动项</div>
            {diff.added_action_items.map((a) => (
              <div className="diff-item added" key={a.id}>
                <div className="title">＋ {a.title}</div>
                <div className="meta">
                  {statusLabel(a.status)} · {a.responsible_party} · {a.id}
                </div>
              </div>
            ))}
          </>
        )}

        {diff.changed_action_items.length > 0 && (
          <>
            <div className="diff-section-title">变化行动项（逐字段）</div>
            {diff.changed_action_items.map((c) => {
              const base = baseActionMap.get(c.id);
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
                  {base && (
                    <div className="meta">父包原值：{statusLabel(base.status)}</div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {diff.added_timeline_events.length > 0 && (
          <>
            <div className="diff-section-title">新增时间线事件</div>
            {diff.added_timeline_events.map((t) => (
              <div className="diff-item added" key={t.id}>
                <div className="title">
                  ＋ {kindLabel(t.kind)}
                  {baseTimelineIds.has(t.id) ? "" : ""}
                </div>
                <div className="meta">
                  {t.description} · {formatDateTime(t.occurred_at)}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
