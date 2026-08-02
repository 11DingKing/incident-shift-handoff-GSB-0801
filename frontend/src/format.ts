export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function statusLabel(status: string): string {
  switch (status) {
    case "open":
      return "待处理";
    case "in_progress":
      return "进行中";
    case "blocked":
      return "受阻";
    case "done":
      return "已完成";
    case "draft":
      return "草稿";
    case "signed":
      return "已签收";
    case "active":
      return "处置中";
    case "monitoring":
      return "监测中";
    case "closed":
      return "已结束";
    default:
      return status;
  }
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case "road_closure":
      return "主路封闭";
    case "road_reopened":
      return "道路恢复通行";
    case "evidence_intake":
      return "证据入库";
    case "handoff_signed":
      return "交接签收";
    case "action_item_updated":
      return "行动项更新";
    case "action_item_added":
      return "行动项新增";
    case "field_report":
      return "现场报告";
    default:
      return kind;
  }
}
