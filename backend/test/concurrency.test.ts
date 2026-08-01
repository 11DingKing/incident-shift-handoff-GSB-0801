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

describe("并发与乐观锁冲突", () => {
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

  it("两个客户端同版本更新同一字段：一个成功，一个返回字段级冲突而非静默覆盖", async () => {
    const payload = (status: string, actor: string) => ({
      method: "PATCH" as const,
      url: `/api/action-items/${ACTION_ITEM_1}`,
      payload: {
        expectedVersion: 1,
        actor,
        patch: { status },
      },
    });

    const [resA, resB] = await Promise.all([
      app.inject(payload("done", "客户A")),
      app.inject(payload("blocked", "客户B")),
    ]);

    const codes = [resA.statusCode, resB.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const conflict = resA.statusCode === 409 ? resA.json() : resB.json();
    expect(conflict.error).toBe("optimistic_lock_conflict");
    expect(conflict.currentVersion).toBe(2);
    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.conflicts[0].field).toBe("status");
    expect(conflict.conflicts[0].base).toBe("in_progress");
    expect(["done", "blocked"]).toContain(conflict.conflicts[0].current);
    expect(["done", "blocked"]).toContain(conflict.conflicts[0].attempted);
    expect(conflict.conflicts[0].current).not.toBe(
      conflict.conflicts[0].attempted
    );

    const final = await query<{ version: number; status: string }>(
      `SELECT version, status FROM action_items WHERE id = $1`,
      [ACTION_ITEM_1]
    );
    expect(final[0]!.version).toBe(2);
  });

  it("两个客户端更新不同行动项互不阻塞，均成功", async () => {
    const [r1, r2] = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/action-items/act-gd-20260729-01-a1`,
        payload: { expectedVersion: 1, actor: "A", patch: { status: "done" } },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/action-items/act-gd-20260729-01-a2`,
        payload: {
          expectedVersion: 1,
          actor: "B",
          patch: { status: "in_progress" },
        },
      }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
  });

  it("并发签收同一交接包：快照/时间线/审计仅产生一份", async () => {
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

    const [s1, s2] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/handoffs/${handoff.id}/sign`,
        payload: { actor: "李四" },
      }),
      app.inject({
        method: "POST",
        url: `/api/handoffs/${handoff.id}/sign`,
        payload: { actor: "李四" },
      }),
    ]);
    expect(s1.statusCode).toBe(200);
    expect(s2.statusCode).toBe(200);
    expect(s1.json().status).toBe("signed");
    expect(s2.json().status).toBe("signed");

    const tl = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM timeline_events
       WHERE kind = 'handoff_signed' AND incident_id = $1`,
      [INCIDENT_ID]
    );
    expect(Number(tl[0]!.count)).toBe(1);

    const audit = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
       WHERE handoff_id = $1 AND event_type = 'handoff.signed'`,
      [handoff.id]
    );
    expect(Number(audit[0]!.count)).toBe(1);

    const sh = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM handoffs WHERE id = $1 AND snapshot IS NOT NULL`,
      [handoff.id]
    );
    expect(Number(sh[0]!.count)).toBe(1);
  });

  it("并发逐项确认同一事项：只有一份确认落库（唯一约束 + 捕获）", async () => {
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

    const [a1, a2] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/handoffs/${handoff.id}/acknowledgements`,
        payload: {
          item_type: "action_item",
          item_id: ACTION_ITEM_1,
          acknowledged_by: "李四",
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/handoffs/${handoff.id}/acknowledgements`,
        payload: {
          item_type: "action_item",
          item_id: ACTION_ITEM_1,
          acknowledged_by: "李四",
        },
      }),
    ]);

    const codes = [a1.statusCode, a2.statusCode].sort();
    expect(codes).toEqual([200, 201]);
    const replayed = a1.statusCode === 200 ? a1.json() : a2.json();
    expect(replayed.replayed).toBe(true);

    const rows = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM acknowledgements
       WHERE handoff_id = $1 AND item_id = $2`,
      [handoff.id, ACTION_ITEM_1]
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it("签收后两个客户端并发更新行动项，补充事件顺序一致且不重复", async () => {
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

    const [u1, u2] = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/action-items/${ACTION_ITEM_1}`,
        payload: { expectedVersion: 1, actor: "A", patch: { status: "done" } },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/action-items/act-gd-20260729-01-a2`,
        payload: {
          expectedVersion: 1,
          actor: "B",
          patch: { status: "in_progress" },
        },
      }),
    ]);
    expect(u1.statusCode).toBe(200);
    expect(u2.statusCode).toBe(200);

    const supp = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM supplemental_events WHERE parent_handoff_id = $1`,
      [handoff.id]
    );
    expect(Number(supp[0]!.count)).toBe(2);
  });
});
