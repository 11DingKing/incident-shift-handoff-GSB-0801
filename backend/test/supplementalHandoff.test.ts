import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ensureMigrated,
  resetDatabase,
  makeApp,
  closeApp,
  query,
  INCIDENT_ID,
  ACTION_ITEM_1,
} from "./helpers.js";

const EV_03 = "ev-gd-20260729-03";
const AI_03 = "ai-gd-20260729-03";

async function createAndSign(app: FastifyInstance, actor = "交班人") {
  const create = await app.inject({
    method: "POST",
    url: `/api/incidents/${INCIDENT_ID}/handoffs`,
    payload: {
      from_shift: "夜班",
      to_shift: "白班",
      summary: "初始交接",
      created_by: actor,
    },
  });
  const handoff = create.json();
  await app.inject({
    method: "POST",
    url: `/api/handoffs/${handoff.id}/sign`,
    payload: { actor: "接班人" },
  });
  return handoff.id as string;
}

describe("补充交接包（显式创建 + 逐字段差异）", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await ensureMigrated();
    app = makeApp();
    await app.ready();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  it("签收后追加稳定 ID 的时间线与行动项，补充包只快照新增/变化并保存逐字段差异", async () => {
    const parentId = await createAndSign(app);

    const before = await query<{
      created_by: string;
      status: string;
      version: number;
      snapshot: { action_items: { id: string }[] };
    }>(`SELECT created_by, status, version, snapshot FROM handoffs WHERE id = $1`, [
      parentId,
    ]);
    expect(before[0]!.status).toBe("signed");
    expect(before[0]!.version).toBe(2);
    expect(before[0]!.created_by).toBe("交班人");

    const tlRes = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT_ID}/timeline`,
      payload: {
        id: EV_03,
        kind: "road_reopened",
        description: "东侧绕行路线重新开放，主路恢复通行。",
        responsible_party: "交通协调组",
        occurred_at: "2026-07-29T14:30:00+08:00",
        actor: "交通协调组-赵六",
      },
    });
    expect(tlRes.statusCode).toBe(201);
    expect(tlRes.json().id).toBe(EV_03);

    const aiRes = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT_ID}/action-items`,
      payload: {
        id: AI_03,
        title: "东侧绕行路线重新开放",
        detail: "确认排水完成，道路恢复双向通行。",
        status: "open",
        responsible_party: "交通协调组",
        occurred_at: "2026-07-29T14:30:00+08:00",
        actor: "交通协调组-赵六",
      },
    });
    expect(aiRes.statusCode).toBe(201);
    expect(aiRes.json().action_item.id).toBe(AI_03);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/action-items/${ACTION_ITEM_1}`,
      payload: {
        expectedVersion: 1,
        actor: "交通协调组-赵六",
        patch: { status: "done", detail: "复核完成，路线已开放。" },
      },
    });
    expect(patchRes.statusCode).toBe(200);

    const shRes = await app.inject({
      method: "POST",
      url: `/api/handoffs/${parentId}/supplemental-handoff`,
      payload: { actor: "接班人-李四", summary: "签收后变化补充" },
    });
    expect(shRes.statusCode).toBe(201);
    const sh = shRes.json();
    expect(sh.parent_handoff_id).toBe(parentId);
    const diff = sh.diff;
    expect(diff.added_timeline_events).toHaveLength(1);
    expect(diff.added_timeline_events[0].id).toBe(EV_03);
    expect(diff.added_action_items).toHaveLength(1);
    expect(diff.added_action_items[0].id).toBe(AI_03);
    expect(diff.changed_action_items).toHaveLength(1);
    const changed = diff.changed_action_items[0];
    expect(changed.id).toBe(ACTION_ITEM_1);
    expect(changed.from_version).toBe(1);
    expect(changed.to_version).toBe(2);
    expect(changed.changes.status.from).toBe("in_progress");
    expect(changed.changes.status.to).toBe("done");
    expect(changed.changes.detail.from).toBe("复核东侧绕行道路通行条件与导流标识。");
    expect(changed.changes.detail.to).toBe("复核完成，路线已开放。");
  });

  it("父包责任人、状态、版本和确认记录不变", async () => {
    const parentId = await createAndSign(app);

    await app.inject({
      method: "POST",
      url: `/api/handoffs/${parentId}/acknowledgements`,
      payload: {
        item_type: "action_item",
        item_id: ACTION_ITEM_1,
        acknowledged_by: "接班人-李四",
      },
    });

    await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT_ID}/action-items`,
      payload: {
        id: AI_03,
        title: "东侧绕行路线重新开放",
        responsible_party: "交通协调组",
        actor: "赵六",
      },
    });

    await app.inject({
      method: "POST",
      url: `/api/handoffs/${parentId}/supplemental-handoff`,
      payload: { actor: "接班人-李四" },
    });

    const parent = await query<{
      created_by: string;
      status: string;
      version: number;
      signed_off_by: string;
    }>(
      `SELECT created_by, status, version, signed_off_by FROM handoffs WHERE id = $1`,
      [parentId]
    );
    expect(parent[0]!.status).toBe("signed");
    expect(parent[0]!.version).toBe(2);
    expect(parent[0]!.created_by).toBe("交班人");
    expect(parent[0]!.signed_off_by).toBe("接班人");

    const acks = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM acknowledgements WHERE handoff_id = $1`,
      [parentId]
    );
    expect(Number(acks[0]!.count)).toBe(1);

    const snapshotA1 = await query<{ snapshot: { action_items: { id: string; status: string }[] } }>(
      `SELECT snapshot FROM handoffs WHERE id = $1`,
      [parentId]
    );
    const frozen = snapshotA1[0]!.snapshot.action_items.find(
      (a) => a.id === ACTION_ITEM_1
    );
    expect(frozen!.status).toBe("in_progress");
  });

  it("草稿交接包不能创建补充交接包", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT_ID}/handoffs`,
      payload: {
        from_shift: "夜班",
        to_shift: "白班",
        summary: "",
        created_by: "甲",
      },
    });
    const draft = create.json();
    const res = await app.inject({
      method: "POST",
      url: `/api/handoffs/${draft.id}/supplemental-handoff`,
      payload: { actor: "乙" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("immutable_resource");
  });

  it("同一幂等键重试与重复请求只返回同一个补充包", async () => {
    const parentId = await createAndSign(app);
    await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT_ID}/action-items`,
      payload: {
        id: AI_03,
        title: "新增事项",
        responsible_party: "交通协调组",
        actor: "赵六",
      },
    });

    const headers = { "idempotency-key": "sh-key-123" };
    const r1 = await app.inject({
      method: "POST",
      url: `/api/handoffs/${parentId}/supplemental-handoff`,
      headers,
      payload: { actor: "接班人-李四" },
    });
    const r2 = await app.inject({
      method: "POST",
      url: `/api/handoffs/${parentId}/supplemental-handoff`,
      headers,
      payload: { actor: "接班人-李四" },
    });
    const r3 = await app.inject({
      method: "POST",
      url: `/api/handoffs/${parentId}/supplemental-handoff`,
      payload: { actor: "接班人-李四" },
    });

    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(200);
    expect(r1.json().id).toBe(r2.json().id);
    expect(r1.json().id).toBe(r3.json().id);

    const rows = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM supplemental_handoffs WHERE parent_handoff_id = $1`,
      [parentId]
    );
    expect(Number(rows[0]!.count)).toBe(1);

    const audits = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
       WHERE handoff_id = $1 AND event_type = 'supplemental_handoff.created'`,
      [parentId]
    );
    expect(Number(audits[0]!.count)).toBe(1);
  });

  it("并发创建补充交接包：只产生一个补充包、一组差异和一条审计事件", async () => {
    const parentId = await createAndSign(app);
    await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT_ID}/timeline`,
      payload: {
        id: EV_03,
        kind: "road_reopened",
        description: "东侧绕行路线重新开放",
        responsible_party: "交通协调组",
        actor: "赵六",
      },
    });

    const [c1, c2, c3] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/handoffs/${parentId}/supplemental-handoff`,
        payload: { actor: "接班人A" },
      }),
      app.inject({
        method: "POST",
        url: `/api/handoffs/${parentId}/supplemental-handoff`,
        payload: { actor: "接班人B" },
      }),
      app.inject({
        method: "POST",
        url: `/api/handoffs/${parentId}/supplemental-handoff`,
        payload: { actor: "接班人C" },
      }),
    ]);

    const created = [c1, c2, c3].filter((r) => r.statusCode === 201);
    const replayed = [c1, c2, c3].filter((r) => r.statusCode === 200);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(2);
    const ids = new Set([c1.json().id, c2.json().id, c3.json().id]);
    expect(ids.size).toBe(1);

    const shRows = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM supplemental_handoffs WHERE parent_handoff_id = $1`,
      [parentId]
    );
    expect(Number(shRows[0]!.count)).toBe(1);

    const diffRows = await query<{ diff: { added_timeline_events: unknown[] } }>(
      `SELECT diff FROM supplemental_handoffs WHERE parent_handoff_id = $1`,
      [parentId]
    );
    expect(diffRows[0]!.diff.added_timeline_events).toHaveLength(1);

    const auditRows = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
       WHERE handoff_id = $1 AND event_type = 'supplemental_handoff.created'`,
      [parentId]
    );
    expect(Number(auditRows[0]!.count)).toBe(1);
  });

  it("稳定 ID 重复创建行动项/时间线是幂等的，不产生重复行", async () => {
    const payload = {
      id: AI_03,
      title: "东侧绕行路线重新开放",
      responsible_party: "交通协调组",
      actor: "赵六",
    };
    const r1 = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT_ID}/action-items`,
      payload,
    });
    const r2 = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT_ID}/action-items`,
      headers: { "idempotency-key": "ai-03" },
      payload,
    });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(200);

    const rows = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM action_items WHERE id = $1`,
      [AI_03]
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });
});
