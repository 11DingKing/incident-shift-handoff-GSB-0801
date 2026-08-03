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
  ACTION_ITEM_2,
  TIMELINE_1,
  TIMELINE_2,
} from "./helpers.js";

describe("应急事件交接 API", () => {
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

  it("返回初始事件、两个行动项与两条时间线（稳定 ID/责任方/时间）", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/incidents/${INCIDENT_ID}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.incident.id).toBe(INCIDENT_ID);
    expect(body.incident.responsible_party).toBe("应急指挥中心");
    expect(body.action_items).toHaveLength(2);
    expect(body.timeline_events).toHaveLength(2);

    const a1 = body.action_items.find((a: { id: string }) => a.id === ACTION_ITEM_1);
    expect(a1.title).toBe("复核东侧绕行路线");
    expect(a1.responsible_party).toBe("交通协调组");
    expect(a1.status).toBe("in_progress");
    expect(a1.version).toBe(1);

    const a2 = body.action_items.find((a: { id: string }) => a.id === ACTION_ITEM_2);
    expect(a2.status).toBe("open");

    const tl = body.timeline_events.map((t: { kind: string }) => t.kind);
    expect(tl).toEqual(["road_closure", "evidence_intake"]);
  });

  it("创建交接包、逐项确认并原子签收：快照/时间线/审计同时产生", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT_ID}/handoffs`,
      payload: {
        from_shift: "夜班 20:00-08:00",
        to_shift: "白班 08:00-20:00",
        summary: "主路封闭，绕行复核中。",
        created_by: "夜班指挥员-张三",
      },
    });
    expect(create.statusCode).toBe(201);
    const handoff = create.json();
    expect(handoff.status).toBe("draft");

    const ack1 = await app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/acknowledgements`,
      payload: {
        item_type: "action_item",
        item_id: ACTION_ITEM_1,
        acknowledged_by: "接班人-李四",
        note: "已看到",
      },
    });
    expect(ack1.statusCode).toBe(201);
    expect(ack1.json().acknowledgement.acked_version).toBe(1);

    const sign = await app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/sign`,
      payload: { actor: "接班人-李四" },
    });
    expect(sign.statusCode).toBe(200);
    const signed = sign.json();
    expect(signed.status).toBe("signed");
    expect(signed.snapshot).toBeTruthy();
    expect(signed.snapshot.action_items).toHaveLength(2);
    expect(signed.snapshot.timeline_events).toHaveLength(3);
    expect(
      signed.snapshot.timeline_events.some(
        (t: { kind: string }) => t.kind === "handoff_signed"
      )
    ).toBe(true);
    expect(signed.signed_off_by).toBe("接班人-李四");

    const timeline = await query<{ kind: string }>(
      `SELECT kind FROM timeline_events WHERE incident_id = $1 ORDER BY occurred_at`,
      [INCIDENT_ID]
    );
    const kinds = timeline.map((t) => t.kind);
    expect(kinds).toContain("handoff_signed");
    expect(kinds.filter((k) => k === "handoff_signed")).toHaveLength(1);

    const audits = await query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE handoff_id = $1 ORDER BY id`,
      [handoff.id]
    );
    const auditTypes = audits.map((a) => a.event_type);
    expect(auditTypes).toEqual(
      expect.arrayContaining([
        "handoff.created",
        "acknowledgement.created",
        "handoff.signed",
      ])
    );
  });

  it("已签收交接包不可修改：重复签收幂等且不产生重复快照/时间线", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT_ID}/handoffs`,
      payload: {
        from_shift: "夜班",
        to_shift: "白班",
        summary: "交接",
        created_by: "张三",
      },
    });
    const handoff = create.json();

    await app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/sign`,
      payload: { actor: "李四" },
    });

    const resign = await app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/sign`,
      payload: { actor: "李四" },
    });
    expect(resign.statusCode).toBe(200);
    expect(resign.json().status).toBe("signed");

    const signedCount = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM timeline_events
       WHERE kind = 'handoff_signed' AND incident_id = $1`,
      [INCIDENT_ID]
    );
    expect(Number(signedCount[0]!.count)).toBe(1);

    const directUpdate = await query(
      `UPDATE handoffs SET summary = '被篡改' WHERE id = $1`,
      [handoff.id]
    ).catch((e: Error) => e);
    expect(directUpdate).toBeInstanceOf(Error);
    expect(String(directUpdate)).toMatch(/immutable/);
  });

  it("行动项乐观锁更新并记录版本历史", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/action-items/${ACTION_ITEM_1}`,
      payload: {
        expectedVersion: 1,
        actor: "交通协调组-王五",
        patch: { status: "done", detail: "绕行路线已复核通过。" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.action_item.version).toBe(2);
    expect(body.action_item.status).toBe("done");

    const revisions = await query<{ version: number }>(
      `SELECT version FROM action_item_revisions WHERE action_item_id = $1 ORDER BY version`,
      [ACTION_ITEM_1]
    );
    expect(revisions.map((r) => r.version)).toEqual([1, 2]);
  });

  it("重复确认被幂等去重（断线重试不产生第二份确认）", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT_ID}/handoffs`,
      payload: {
        from_shift: "夜班",
        to_shift: "白班",
        summary: "交接",
        created_by: "张三",
      },
    });
    const handoff = create.json();

    const payload = {
      item_type: "timeline_event",
      item_id: TIMELINE_1,
      acknowledged_by: "李四",
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/acknowledgements`,
      headers: { "idempotency-key": "ack-123" },
      payload,
    });
    expect(first.statusCode).toBe(201);

    const retry = await app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/acknowledgements`,
      headers: { "idempotency-key": "ack-123" },
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().replayed).toBe(true);

    const noKeyRetry = await app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/acknowledgements`,
      payload,
    });
    expect(noKeyRetry.statusCode).toBe(200);
    expect(noKeyRetry.json().replayed).toBe(true);

    const count = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM acknowledgements WHERE handoff_id = $1`,
      [handoff.id]
    );
    expect(Number(count[0]!.count)).toBe(1);
  });

  it("签收后更新行动项自动追加为补充事件并关联原交接包，未确认项不被关闭", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT_ID}/handoffs`,
      payload: {
        from_shift: "夜班",
        to_shift: "白班",
        summary: "交接",
        created_by: "张三",
      },
    });
    const handoff = create.json();
    await app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/sign`,
      payload: { actor: "李四" },
    });

    const beforeA2 = await query<{ status: string; version: number }>(
      `SELECT status, version FROM action_items WHERE id = $1`,
      [ACTION_ITEM_2]
    );
    expect(beforeA2[0]!.status).toBe("open");

    const update = await app.inject({
      method: "PATCH",
      url: `/api/action-items/${ACTION_ITEM_2}`,
      payload: {
        expectedVersion: 1,
        actor: "现场处置组",
        patch: { status: "in_progress" },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().supplemental_event_id).toBeTruthy();

    const supp = await query<{ parent_handoff_id: string; kind: string }>(
      `SELECT parent_handoff_id, kind FROM supplemental_events WHERE incident_id = $1`,
      [INCIDENT_ID]
    );
    expect(supp).toHaveLength(1);
    expect(supp[0]!.parent_handoff_id).toBe(handoff.id);
    expect(supp[0]!.kind).toBe("action_item_updated");

    const snapshotA2 = (update.json() as { action_item: { status: string } })
      .action_item;
    const frozen = await query<{ snapshot: { action_items: { id: string; status: string }[] } }>(
      `SELECT snapshot FROM handoffs WHERE id = $1`,
      [handoff.id]
    );
    const frozenA2 = frozen[0]!.snapshot.action_items.find(
      (a) => a.id === ACTION_ITEM_2
    );
    expect(frozenA2!.status).toBe("open");
    expect(snapshotA2.status).toBe("in_progress");

    const ackCount = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM acknowledgements WHERE handoff_id = $1 AND item_id = $2`,
      [handoff.id, ACTION_ITEM_2]
    );
    expect(Number(ackCount[0]!.count)).toBe(0);
  });

  it("只能对已签收交接包追加补充事件", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT_ID}/handoffs`,
      payload: {
        from_shift: "夜班",
        to_shift: "白班",
        summary: "交接",
        created_by: "张三",
      },
    });
    const handoff = create.json();

    const toDraft = await app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/supplemental-events`,
      payload: {
        kind: "field_report",
        description: "新增现场报告",
        responsible_party: "现场处置组",
        actor: "李四",
      },
    });
    expect(toDraft.statusCode).toBe(409);

    await app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/sign`,
      payload: { actor: "李四" },
    });
    const toSigned = await app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/supplemental-events`,
      payload: {
        kind: "field_report",
        description: "新增现场报告",
        responsible_party: "现场处置组",
        actor: "李四",
      },
    });
    expect(toSigned.statusCode).toBe(201);
  });
});
