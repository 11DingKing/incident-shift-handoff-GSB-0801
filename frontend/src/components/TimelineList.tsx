import { useRef, useState } from "react";
import { api } from "../api";
import type { TimelineEvent } from "../types";
import { formatDateTime, kindLabel } from "../format";
import { useToast } from "../toast";

interface Props {
  events: TimelineEvent[];
  incidentId: string;
  actor: string;
  acknowledgedIds: Set<string>;
  onChanged: () => void | Promise<void>;
}

export function TimelineList({
  events,
  incidentId,
  actor,
  acknowledgedIds,
  onChanged,
}: Props) {
  const { notify } = useToast();
  const [kind, setKind] = useState("field_report");
  const [desc, setDesc] = useState("");
  const [responsible, setResponsible] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const descRef = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!actor) {
      notify("请先在右上角填写当前值班人", "err");
      return;
    }
    if (!desc.trim() || !responsible.trim()) {
      notify("请填写事件描述与责任方", "err");
      return;
    }
    setSubmitting(true);
    try {
      await api.addTimeline(incidentId, {
        kind,
        description: desc.trim(),
        responsible_party: responsible.trim(),
        actor,
      });
      setDesc("");
      setResponsible("");
      notify("时间线事件已追加", "ok");
      await onChanged();
      descRef.current?.focus();
    } catch (err) {
      notify(err instanceof Error ? err.message : "追加失败", "err");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {events.map((ev) => (
        <div className="timeline-item" key={ev.id}>
          <div className="kind">{kindLabel(ev.kind)}</div>
          <div className="desc">{ev.description}</div>
          <div className="meta">
            <span
              className={`ack-dot ${
                acknowledgedIds.has(ev.id) ? "yes" : "no"
              }`}
              title={acknowledgedIds.has(ev.id) ? "已确认" : "未确认"}
            />{" "}
            {ev.responsible_party} · {formatDateTime(ev.occurred_at)}
          </div>
        </div>
      ))}

      <h3>追加时间线事件</h3>
      <form onSubmit={submit} className="form-row" style={{ flexWrap: "wrap" }}>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="field_report">现场报告</option>
          <option value="status_update">状态更新</option>
          <option value="evidence_intake">证据入库</option>
          <option value="road_closure">道路管制</option>
        </select>
        <input
          ref={descRef}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="事件描述"
          style={{ flex: 1, minWidth: 200 }}
          aria-label="事件描述"
        />
        <input
          value={responsible}
          onChange={(e) => setResponsible(e.target.value)}
          placeholder="责任方"
          aria-label="责任方"
        />
        <button type="submit" disabled={submitting} className="primary">
          追加
        </button>
      </form>
    </div>
  );
}
