import type { Incident } from "../types";
import { formatDateTime, statusLabel } from "../format";
import type { ConnectionState } from "../hooks/useIncidentLive";

interface Props {
  incident: Incident;
  connection: ConnectionState;
  lastUpdated: Date | null;
  onRefresh: () => void;
}

function connLabel(c: ConnectionState): string {
  switch (c) {
    case "open":
      return "实时已连接";
    case "connecting":
      return "连接中";
    case "polling":
      return "断线轮询中";
    case "closed":
      return "已断开";
  }
}

export function IncidentHeader({
  incident,
  connection,
  lastUpdated,
  onRefresh,
}: Props) {
  return (
    <div className="panel">
      <h1 className="incident-title">{incident.title}</h1>
      <div className="muted">
        {incident.id} · 责任方：{incident.responsible_party} · 发生时间：
        {formatDateTime(incident.occurred_at)}
      </div>
      <div className="badges">
        <span className={`badge ${incident.severity}`}>
          严重度：{incident.severity}
        </span>
        <span className={`badge ${incident.status}`}>
          状态：{statusLabel(incident.status)}
        </span>
        <span className="conn badge" aria-live="polite">
          <span className={`dot ${connection}`} />
          {connLabel(connection)}
          {lastUpdated && (
            <span style={{ marginLeft: 6 }}>
              · 更新于 {formatDateTime(lastUpdated.toISOString())}
            </span>
          )}
        </span>
        <button className="ghost" onClick={onRefresh} aria-label="立即刷新">
          刷新
        </button>
      </div>
    </div>
  );
}
