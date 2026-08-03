import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type {
  Handoff,
  HandoffDetail,
  ActionItem,
  TimelineEvent,
  ItemType,
} from "../types";
import { formatDateTime, kindLabel, statusLabel } from "../format";
import { useToast } from "../toast";
import { SupplementalDiffView } from "./SupplementalDiffView";

interface Props {
  incidentId: string;
  handoffs: Handoff[];
  liveActionItems: ActionItem[];
  actor: string;
  onChanged: () => void | Promise<void>;
}

export function HandoffPanel({
  incidentId,
  handoffs,
  liveActionItems,
  actor,
  onChanged,
}: Props) {
  const { notify } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(
    handoffs[handoffs.length - 1]?.id ?? null,
  );
  const [detail, setDetail] = useState<HandoffDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [fromShift, setFromShift] = useState("夜班 20:00-08:00");
  const [toShift, setToShift] = useState("白班 08:00-20:00");
  const [summary, setSummary] = useState("");
  const [creating, setCreating] = useState(false);

  const loadDetail = useCallback(
    async (id: string) => {
      setLoadingDetail(true);
      try {
        const d = await api.getHandoff(id);
        setDetail(d);
      } catch (e) {
        notify(e instanceof Error ? e.message : "加载交接包失败", "err");
      } finally {
        setLoadingDetail(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (!selectedId && handoffs.length > 0) {
      setSelectedId(handoffs[handoffs.length - 1]!.id);
    }
  }, [handoffs, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const timer = setInterval(() => {
      void loadDetail(selectedId);
    }, 3000);
    return () => clearInterval(timer);
  }, [selectedId, loadDetail]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!actor) {
      notify("请先在右上角填写当前值班人", "err");
      return;
    }
    if (!fromShift || !toShift) {
      notify("请填写班次", "err");
      return;
    }
    setCreating(true);
    try {
      const h = await api.createHandoff(incidentId, {
        from_shift: fromShift,
        to_shift: toShift,
        summary,
        created_by: actor,
      });
      setSelectedId(h.id);
      setSummary("");
      notify("交接包已创建", "ok");
      await onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "创建失败", "err");
    } finally {
      setCreating(false);
    }
  }

  const handoff = handoffs.find((h) => h.id === selectedId) ?? null;

  return (
    <div>
      <form onSubmit={create} className="form-row" style={{ marginBottom: 12 }}>
        <input
          value={fromShift}
          onChange={(e) => setFromShift(e.target.value)}
          placeholder="交班班次"
          aria-label="交班班次"
        />
        <span className="muted">→</span>
        <input
          value={toShift}
          onChange={(e) => setToShift(e.target.value)}
          placeholder="接班班次"
          aria-label="接班班次"
        />
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="交接摘要（可选）"
          style={{ flex: 1, minWidth: 180 }}
          aria-label="交接摘要"
        />
        <button type="submit" disabled={creating} className="primary">
          新建交接包
        </button>
      </form>

      <div className="form-row" role="tablist" aria-label="交接包列表">
        {handoffs.length === 0 && <span className="muted">暂无交接包</span>}
        {handoffs.map((h) => (
          <button
            key={h.id}
            role="tab"
            aria-selected={h.id === selectedId}
            className={h.id === selectedId ? "primary" : "ghost"}
            onClick={() => setSelectedId(h.id)}
            style={{ fontSize: 12 }}
          >
            {h.status === "signed" ? "🔒 " : "📝 "}
            {h.from_shift}→{h.to_shift}
          </button>
        ))}
      </div>

      {handoff && (
        <HandoffDetailView
          key={handoff.id}
          handoff={handoff}
          detail={detail}
          loading={loadingDetail}
          actor={actor}
          liveActionItems={liveActionItems}
          onChanged={async () => {
            await onChanged();
            await loadDetail(handoff.id);
          }}
        />
      )}
    </div>
  );
}

interface DetailProps {
  handoff: Handoff;
  detail: HandoffDetail | null;
  loading: boolean;
  actor: string;
  liveActionItems: ActionItem[];
  onChanged: () => void | Promise<void>;
}

function HandoffDetailView({
  handoff,
  detail,
  loading,
  actor,
  liveActionItems,
  onChanged,
}: DetailProps) {
  const { notify } = useToast();
  const [signing, setSigning] = useState(false);
  const [seKind, setSeKind] = useState("field_report");
  const [seDesc, setSeDesc] = useState("");
  const [seResp, setSeResp] = useState("");
  const [seSubmitting, setSeSubmitting] = useState(false);
  const [generatingSh, setGeneratingSh] = useState(false);
  const confirmBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const ackMap = new Map(
    (detail?.acknowledgements ?? []).map((a) => [
      `${a.item_type}:${a.item_id}`,
      a,
    ]),
  );

  const actionItems: ActionItem[] = handoff.snapshot
    ? handoff.snapshot.action_items
    : [];
  const timelineEvents: TimelineEvent[] = handoff.snapshot
    ? handoff.snapshot.timeline_events
    : [];

  async function sign() {
    if (!actor) {
      notify("请先在右上角填写当前值班人", "err");
      return;
    }
    setSigning(true);
    try {
      await api.signHandoff(handoff.id, actor);
      notify("交接包已签收，快照已固化", "ok");
      await onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "签收失败", "err");
    } finally {
      setSigning(false);
    }
  }

  async function acknowledge(
    itemType: ItemType,
    itemId: string,
    title: string,
  ) {
    if (!actor) {
      notify("请先在右上角填写当前值班人", "err");
      return;
    }
    try {
      const r = await api.acknowledge(handoff.id, {
        item_type: itemType,
        item_id: itemId,
        acknowledged_by: actor,
      });
      notify(
        r.replayed ? `「${title}」已确认过，无需重复` : `已确认「${title}」`,
        r.replayed ? "info" : "ok",
      );
      await onChanged();
      requestAnimationFrame(() => {
        confirmBtnRefs.current[`${itemType}:${itemId}`]?.focus();
      });
    } catch (err) {
      notify(err instanceof Error ? err.message : "确认失败", "err");
    }
  }

  async function appendSupplemental(e: React.FormEvent) {
    e.preventDefault();
    if (!actor) {
      notify("请先在右上角填写当前值班人", "err");
      return;
    }
    if (!seDesc.trim() || !seResp.trim()) {
      notify("请填写描述与责任方", "err");
      return;
    }
    setSeSubmitting(true);
    try {
      await api.appendSupplemental(handoff.id, {
        kind: seKind,
        description: seDesc.trim(),
        responsible_party: seResp.trim(),
        actor,
      });
      setSeDesc("");
      setSeResp("");
      notify("补充事件已追加", "ok");
      await onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "追加失败", "err");
    } finally {
      setSeSubmitting(false);
    }
  }

  async function generateSupplemental() {
    if (!actor) {
      notify("请先在右上角填写当前值班人", "err");
      return;
    }
    setGeneratingSh(true);
    try {
      const sh = await api.createSupplementalHandoff(handoff.id, actor);
      notify(
        `补充交接包已生成：新增行动项 ${sh.diff.added_action_items.length} / 变化 ${sh.diff.changed_action_items.length} / 新增时间线 ${sh.diff.added_timeline_events.length}`,
        "ok",
      );
      await onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "生成失败", "err");
    } finally {
      setGeneratingSh(false);
    }
  }

  const allItems = [
    ...actionItems.map((a) => ({
      key: `action_item:${a.id}` as const,
      type: "action_item" as ItemType,
      id: a.id,
      title: a.title,
      meta: `行动项 · ${statusLabel(a.status)} · ${a.responsible_party}`,
    })),
    ...timelineEvents.map((t) => ({
      key: `timeline_event:${t.id}` as const,
      type: "timeline_event" as ItemType,
      id: t.id,
      title: t.description,
      meta: `${kindLabel(t.kind)} · ${t.responsible_party}`,
    })),
  ];

  const confirmedCount = allItems.filter((i) => ackMap.has(i.key)).length;

  return (
    <div className="snapshot" style={{ marginTop: 12 }}>
      <div className="locked">
        {handoff.status === "signed" ? (
          <>
            🔒 已签收快照（不可修改） · 签收人 {handoff.signed_off_by} ·{" "}
            {formatDateTime(handoff.signed_off_at)}
          </>
        ) : (
          <>📝 草稿交接包，尚未签收</>
        )}
      </div>
      <div style={{ marginBottom: 8 }}>
        <strong>{handoff.from_shift}</strong> →{" "}
        <strong>{handoff.to_shift}</strong>
        {handoff.summary && <span className="muted"> · {handoff.summary}</span>}
      </div>

      {handoff.status === "draft" && (
        <button className="primary" onClick={sign} disabled={signing}>
          {signing ? "签收中..." : "签收并固化快照"}
        </button>
      )}

      <h3>
        逐项确认（{confirmedCount}/{allItems.length}）
      </h3>
      {loading && <div className="muted">加载中...</div>}
      {!loading && allItems.length === 0 && (
        <div className="muted">签收后将固化快照与逐项确认清单。</div>
      )}
      {allItems.map((item) => {
        const ack = ackMap.get(item.key);
        return (
          <div
            className="item"
            key={item.key}
            style={{ background: "var(--bg)" }}
          >
            <div className="row">
              <div>
                <div className="title">
                  <span
                    className={`ack-dot ${ack ? "yes" : "no"}`}
                    aria-label={ack ? "已确认" : "未确认"}
                  />{" "}
                  {item.title}
                </div>
                <div className="meta">
                  {item.meta}
                  {ack && (
                    <>
                      {" "}
                      · 由 {ack.acknowledged_by} 确认
                      {ack.acked_version ? ` · v${ack.acked_version}` : ""}
                    </>
                  )}
                </div>
              </div>
              <div className="actions">
                <button
                  ref={(el) => {
                    confirmBtnRefs.current[item.key] = el;
                  }}
                  className={ack ? "ghost" : "primary"}
                  onClick={() => acknowledge(item.type, item.id, item.title)}
                  aria-pressed={Boolean(ack)}
                >
                  {ack ? "已确认（再次确认仍幂等）" : "确认该项"}
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {handoff.status === "signed" && (
        <>
          <h3>
            补充交接包
            {detail?.supplemental_handoff && (
              <span className="badge signed" style={{ marginLeft: 8 }}>
                已生成 {detail.supplemental_handoff.id}
              </span>
            )}
          </h3>
          <button
            className="primary"
            onClick={generateSupplemental}
            disabled={generatingSh}
            aria-label="生成补充交接包"
          >
            {generatingSh
              ? "生成中..."
              : detail?.supplemental_handoff
                ? "重新获取补充交接包（幂等）"
                : "生成补充交接包（快照签收后变化）"}
          </button>

          {handoff.snapshot && detail?.supplemental_handoff && (
            <SupplementalDiffView
              parentSnapshot={handoff.snapshot}
              diff={detail.supplemental_handoff.diff}
              supplementalHandoffId={detail.supplemental_handoff.id}
              acknowledgements={detail.supplemental_acknowledgements ?? []}
              liveActionItems={liveActionItems}
              actor={actor}
              onChanged={onChanged}
            />
          )}

          <h3>签收后补充事件</h3>
          {(detail?.supplemental_events ?? []).length === 0 && (
            <div className="muted">暂无补充事件。</div>
          )}
          {(detail?.supplemental_events ?? []).map((se) => (
            <div className="supplemental" key={se.id}>
              <div>
                <strong>{kindLabel(se.kind)}</strong>: {se.description}
              </div>
              <div className="meta">
                {se.responsible_party} · {formatDateTime(se.occurred_at)} ·{" "}
                {se.id}
              </div>
            </div>
          ))}
          <form onSubmit={appendSupplemental} className="form-row">
            <select
              value={seKind}
              onChange={(e) => setSeKind(e.target.value)}
              aria-label="补充事件类型"
            >
              <option value="field_report">现场报告</option>
              <option value="status_update">状态更新</option>
              <option value="action_item_updated">行动项变更</option>
            </select>
            <input
              value={seDesc}
              onChange={(e) => setSeDesc(e.target.value)}
              placeholder="补充事件描述"
              style={{ flex: 1, minWidth: 180 }}
              aria-label="补充事件描述"
            />
            <input
              value={seResp}
              onChange={(e) => setSeResp(e.target.value)}
              placeholder="责任方"
              aria-label="补充事件责任方"
            />
            <button type="submit" disabled={seSubmitting} className="primary">
              追加
            </button>
          </form>
        </>
      )}
    </div>
  );
}
