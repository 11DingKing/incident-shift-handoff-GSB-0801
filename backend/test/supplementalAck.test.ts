import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ensureMigrated,
  resetDatabase,
  makeApp,
  closeApp,
  query,
  INCIDENT_ID,
} from "./helpers.js";

const AI_03 = "ai-gd-20260729-03";
const EV_03 = "ev-gd-20260729-03";

async function setupSupplemental(app: FastifyInstance) {
  const create = await app.inject({
    method: "POST",
    url: `/api/incidents/${INCIDENT_ID}/handoffs`,
    payload: {
      from_shift: "夜班",
      to_shift: "白班",
      summary: "初始交接",
      created_by: "交班人",
    },
  });
  const handoff = create.json();
  await app.inject({
    method: "POST",
    url: `/api/handoffs/${handoff.id}/sign`,
    payload: { actor: "接班人" },
  });

  await app.inject({
    method: "POST",
    url: `/api/incidents/${INCIDENT_ID}/action-items`,
    payload: {
      id: AI_03,
      title: "东侧绕行路线重新开放",
      detail: "确认排水完成，道路恢复双向通行。",
      status: "open",
      responsible_party: "交通协调组",
      occurred_at: "2026-07-29T14:30:00+08:00",
      actor: "赵六",
    },
  });

  await app.inject({
    method: "POST",
    url: `/api/incidents/${INCIDENT_ID}/timeline`,
    payload: {
      id: EV_03,
      kind: "road_reopened",
      description: "东侧绕行路线重新开放。",
      responsible_party: "交通协调组",
      occurred_at: "2026-07-29T14:30:00+08:00",
      actor: "赵六",
    },
  });

  const shRes = await app.inject({
    method: "POST",
    url: `/api/handoffs/${handoff.id}/supplemental-handoff`,
    payload: { actor: "接班人" },
  });
  const sh = shRes.json();
  return { parentId: handoff.id as string, shId: sh.id as string };
}

describe("补充交接包逐项确认（乐观锁 + 幂等 + 并发）", () => {
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

  it("携带过期版本确认返回 409 并包含字段级当前值，不产生确认记录", async () => {
    const { shId } = await setupSupplemental(app);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/action-items/${AI_03}`,
      payload: {
        expectedVersion: 1,
        actor: "赵六",
        patch: { status: "done", detail: "道路已开放，确认完成。" },
      },
    });
    expect(patch.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: `/api/supplemental-handoffs/${shId}/acknowledgements`,
      payload: {
        item_type: "action_item",
        item_id: AI_03,
        acknowledged_by: "接班人甲",
        expected_version: 1,
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("optimistic_lock_conflict");
    expect(body.currentVersion).toBe(2);
    expect(body.current.status).toBe("done");

    const statusConflict = body.conflicts.find(
      (c: { field: string }) => c.field === "status",
    );
    expect(statusConflict).toBeTruthy();
    expect(statusConflict.base).toBe("open");
    expect(statusConflict.current).toBe("done");

    const detailConflict = body.conflicts.find(
      (c: { field: string }) => c.field === "detail",
    );
    expect(detailConflict.current).toBe("道路已开放，确认完成。");

    const acks = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM acknowledgements
       WHERE supplemental_handoff_id = $1`,
      [shId],
    );
    expect(Number(acks[0]!.count)).toBe(0);
  });

  it("首次有效版本确认成功，确认记录携带 acked_version，不改变行动项状态", async () => {
    const { shId } = await setupSupplemental(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/supplemental-handoffs/${shId}/acknowledgements`,
      payload: {
        item_type: "action_item",
        item_id: AI_03,
        acknowledged_by: "接班人甲",
        expected_version: 1,
      },
    });
    expect(res.statusCode).toBe(201);
    const ack = res.json().acknowledgement;
    expect(ack.supplemental_handoff_id).toBe(shId);
    expect(ack.acked_version).toBe(1);

    const item = await query<{ status: string }>(
      `SELECT status FROM action_items WHERE id = $1`,
      [AI_03],
    );
    expect(item[0]!.status).toBe("open");

    const audits = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
       WHERE event_type = 'supplemental_acknowledgement.created'
         AND payload->>'supplemental_handoff_id' = $1`,
      [shId],
    );
    expect(Number(audits[0]!.count)).toBe(1);
  });

  it("相同幂等键断线重试只返回同一个确认，不重复写审计", async () => {
    const { shId } = await setupSupplemental(app);
    const headers = { "idempotency-key": "supp-ack-retry-1" };

    const r1 = await app.inject({
      method: "POST",
      url: `/api/supplemental-handoffs/${shId}/acknowledgements`,
      headers,
      payload: {
        item_type: "action_item",
        item_id: AI_03,
        acknowledged_by: "接班人甲",
        expected_version: 1,
      },
    });
    const r2 = await app.inject({
      method: "POST",
      url: `/api/supplemental-handoffs/${shId}/acknowledgements`,
      headers,
      payload: {
        item_type: "action_item",
        item_id: AI_03,
        acknowledged_by: "接班人甲",
        expected_version: 1,
      },
    });

    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(200);
    expect(r1.json().acknowledgement.id).toBe(r2.json().acknowledgement.id);

    const acks = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM acknowledgements
       WHERE supplemental_handoff_id = $1 AND item_id = $2`,
      [shId, AI_03],
    );
    expect(Number(acks[0]!.count)).toBe(1);

    const audits = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
       WHERE event_type = 'supplemental_acknowledgement.created'
         AND payload->>'supplemental_handoff_id' = $1`,
      [shId],
    );
    expect(Number(audits[0]!.count)).toBe(1);
  });

  it("并发确认同一补充包项只产生一条确认和一条审计事件", async () => {
    const { shId } = await setupSupplemental(app);

    const [c1, c2, c3] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/supplemental-handoffs/${shId}/acknowledgements`,
        payload: {
          item_type: "action_item",
          item_id: AI_03,
          acknowledged_by: "接班人甲",
          expected_version: 1,
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/supplemental-handoffs/${shId}/acknowledgements`,
        payload: {
          item_type: "action_item",
          item_id: AI_03,
          acknowledged_by: "接班人乙",
          expected_version: 1,
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/supplemental-handoffs/${shId}/acknowledgements`,
        payload: {
          item_type: "action_item",
          item_id: AI_03,
          acknowledged_by: "接班人丙",
          expected_version: 1,
        },
      }),
    ]);

    const created = [c1, c2, c3].filter((r) => r.statusCode === 201);
    const replayed = [c1, c2, c3].filter((r) => r.statusCode === 200);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(2);

    const ids = new Set([
      c1.json().acknowledgement.id,
      c2.json().acknowledgement.id,
      c3.json().acknowledgement.id,
    ]);
    expect(ids.size).toBe(1);

    const acks = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM acknowledgements
       WHERE supplemental_handoff_id = $1 AND item_id = $2`,
      [shId, AI_03],
    );
    expect(Number(acks[0]!.count)).toBe(1);

    const audits = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
       WHERE event_type = 'supplemental_acknowledgement.created'
         AND payload->>'supplemental_handoff_id' = $1`,
      [shId],
    );
    expect(Number(audits[0]!.count)).toBe(1);
  });

  it("父包确认与补充包确认互不污染，父包确认数不变", async () => {
    const { parentId, shId } = await setupSupplemental(app);

    await app.inject({
      method: "POST",
      url: `/api/handoffs/${parentId}/acknowledgements`,
      payload: {
        item_type: "action_item",
        item_id: AI_03,
        acknowledged_by: "接班人甲",
      },
    });

    const suppRes = await app.inject({
      method: "POST",
      url: `/api/supplemental-handoffs/${shId}/acknowledgements`,
      payload: {
        item_type: "action_item",
        item_id: AI_03,
        acknowledged_by: "接班人乙",
        expected_version: 1,
      },
    });
    expect(suppRes.statusCode).toBe(201);

    const parentAcks = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM acknowledgements
       WHERE handoff_id = $1 AND supplemental_handoff_id IS NULL`,
      [parentId],
    );
    expect(Number(parentAcks[0]!.count)).toBe(1);

    const suppAcks = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM acknowledgements
       WHERE supplemental_handoff_id = $1`,
      [shId],
    );
    expect(Number(suppAcks[0]!.count)).toBe(1);

    const detail = await app.inject({
      method: "GET",
      url: `/api/handoffs/${parentId}`,
    });
    const body = detail.json();
    expect(body.acknowledgements).toHaveLength(1);
    expect(body.supplemental_acknowledgements).toHaveLength(1);
  });

  it("确认不在差异清单中的项目返回 404", async () => {
    const { shId } = await setupSupplemental(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/supplemental-handoffs/${shId}/acknowledgements`,
      payload: {
        item_type: "action_item",
        item_id: "act-gd-20260729-01-a1",
        acknowledged_by: "接班人甲",
        expected_version: 2,
      },
    });
    expect(res.statusCode).toBe(404);
  });
});
