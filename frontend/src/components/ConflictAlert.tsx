import type { FieldConflict } from "../types";
import { statusLabel } from "../format";

interface Props {
  message: string;
  currentVersion: number;
  conflicts: FieldConflict[];
  onReload: () => void;
}

function display(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") {
    if (["open", "in_progress", "blocked", "done"].includes(v)) {
      return statusLabel(v);
    }
    return v;
  }
  return JSON.stringify(v);
}

export function ConflictAlert({
  message,
  currentVersion,
  conflicts,
  onReload,
}: Props) {
  return (
    <div className="conflict-box" role="alert">
      <strong>字段级冲突（版本已过期）</strong>
      <div className="muted">{message}</div>
      <div className="muted">服务器当前版本：v{currentVersion}</div>
      {conflicts.length > 0 && (
        <div className="vs">
          <div>
            <div className="muted">你的基准值</div>
            {conflicts.map((c) => (
              <div key={c.field}>
                <span className="field">{c.field}</span>: {display(c.base)}
              </div>
            ))}
          </div>
          <div>
            <div className="muted">服务器现值</div>
            {conflicts.map((c) => (
              <div key={c.field}>
                <span className="field">{c.field}</span>: {display(c.current)}
              </div>
            ))}
          </div>
          <div>
            <div className="muted">你尝试提交</div>
            {conflicts.map((c) => (
              <div key={c.field}>
                <span className="field">{c.field}</span>: {display(c.attempted)}
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <button className="primary" onClick={onReload}>
          重新加载最新状态
        </button>
      </div>
    </div>
  );
}
