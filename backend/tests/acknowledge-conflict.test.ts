import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  closeTestApp,
  resetDatabase,
  endTestPool,
} from "./helpers.js";

const INCIDENT = "inc-gd-20260729-01";
const AI_ROUTE = "ai-gd-20260729-route-review";

describe("Item acknowledgment optimistic locking + idempotency", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await resetDatabase();
    app = await buildTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeTestApp(app);
    await endTestPool();
  });

  async function createSuppWithAi03(): Promise<{ parentId: string; suppId: string; ai03Id: string }> {
    // Primary package + sign off.
    await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT}/handoffs`,
      headers: { "content-type": "application/json" },
      payload: { handoff_id: "hnd-p", from_shift: "白班", to_shift: "夜班", summary: "" },
    });
    await app.inject({
      method: "POST",
      url: "/api/handoffs/hnd-p/acknowledge",
      headers: { "content-type": "application/json" },
      payload: { confirmed_by: "接班人", idempotency_key: "p-pkg" },
    });

    // Add ai-03 after sign off.
    const ai = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT}/action-items`,
      headers: { "content-type": "application/json", "x-actor": "夜班" },
      payload: {
        action_item_id: "ai-gd-20260729-03",
        title: "东侧绕行路线重新开放",
        description: "积水消退，恢复通行",
        status: "open",
        owner: "应急协调组-李工",
      },
    });
    expect(ai.statusCode).toBe(200);

    // Create supplementary package; ai-03 is new -> snapshotted with v1.
    const supp = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT}/handoffs/supplementary`,
      headers: { "content-type": "application/json" },
      payload: {
        handoff_id: "hnd-s",
        parent_handoff_id: "hnd-p",
        from_shift: "夜班",
        to_shift: "早班",
        summary: "",
      },
    });
    expect(supp.statusCode).toBe(200);
    return { parentId: "hnd-p", suppId: "hnd-s", ai03Id: "ai-gd-20260729-03" };
  }

  it("rejects a stale-version item acknowledgment with field-level current values (409)", async () => {
    const { suppId, ai03Id } = await createSuppWithAi03();

    // Another client advances ai-03 from v1 to v2 after the supplementary snapshot.
    await app.inject({
      method: "PATCH",
      url: `/api/action-items/${ai03Id}`,
      headers: { "content-type": "application/json", "x-actor": "夜班" },
      payload: { status: "done", expected_version: 1 },
    });

    // Client confirms against the stale v1 snapshot version.
    const res = await app.inject({
      method: "POST",
      url: `/api/handoffs/${suppId}/items/${ai03Id}/acknowledge`,
      headers: { "content-type": "application/json" },
      payload: {
        confirmed_by: "接班人",
        note: "确认",
        idempotency_key: "stale-key",
        expected_version: 1,
      },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.conflictFields).toBeDefined();
    const statusField = body.conflictFields.find((f: any) => f.field === "status");
    expect(statusField).toBeTruthy();
    expect(statusField.current).toBe("done");
    expect(statusField.current_version).toBe(2);

    // No acknowledgment row was written for the stale attempt.
    const detail = (await app.inject({ method: "GET", url: `/api/handoffs/${suppId}` })).json();
    const acks = detail.acknowledgments.filter((a: any) => a.action_item_id === ai03Id);
    expect(acks).toHaveLength(0);
  });

  it("allows the first valid acknowledgment; same idempotency key retry is idempotent and does not duplicate", async () => {
    const { suppId, ai03Id } = await createSuppWithAi03();

    const payload = {
      confirmed_by: "接班人",
      note: "确认",
      idempotency_key: "same-ack-key",
      expected_version: 1,
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/handoffs/${suppId}/items/${ai03Id}/acknowledge`,
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().alreadyExisted).toBe(false);

    // Simulate a disconnected retry using the same key; even though the item has
    // since advanced to v2, idempotency wins and returns the existing ack.
    await app.inject({
      method: "PATCH",
      url: `/api/action-items/${ai03Id}`,
      headers: { "content-type": "application/json", "x-actor": "夜班" },
      payload: { status: "done", expected_version: 1 },
    });

    const retry = await app.inject({
      method: "POST",
      url: `/api/handoffs/${suppId}/items/${ai03Id}/acknowledge`,
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().alreadyExisted).toBe(true);

    // Exactly one acknowledgment row survives; exactly one item_acknowledged audit.
    const detail = (await app.inject({ method: "GET", url: `/api/handoffs/${suppId}` })).json();
    const acks = detail.acknowledgments.filter((a: any) => a.action_item_id === ai03Id);
    expect(acks).toHaveLength(1);

    const audit = (await app.inject({ method: "GET", url: `/api/incidents/${INCIDENT}/audit` })).json();
    const itemAudits = audit.filter((a: any) => a.action === "item_acknowledged" && a.payload.action_item_id === ai03Id);
    expect(itemAudits).toHaveLength(1);
    // No conflict audit for the idempotent retry.
    const conflicts = audit.filter((a: any) => a.action === "item_acknowledge_conflict");
    expect(conflicts).toHaveLength(0);
  });

  it("concurrent same-key acks produce exactly one confirmation; parent package untouched", async () => {
    const { suppId, parentId, ai03Id } = await createSuppWithAi03();

    const ack = () =>
      app.inject({
        method: "POST",
        url: `/api/handoffs/${suppId}/items/${ai03Id}/acknowledge`,
        headers: { "content-type": "application/json" },
        payload: {
          confirmed_by: "接班人",
          note: "确认",
          idempotency_key: "concurrent-ack-key",
          expected_version: 1,
        },
      });

    const [r1, r2] = await Promise.all([ack(), ack()]);
    expect([r1.statusCode, r2.statusCode].every((s) => s === 200)).toBe(true);

    // Exactly one confirmation on the supplementary package.
    const supp = (await app.inject({ method: "GET", url: `/api/handoffs/${suppId}` })).json();
    const itemAcks = supp.acknowledgments.filter((a: any) => a.action_item_id === ai03Id);
    expect(itemAcks).toHaveLength(1);
    // The supplementary package is still pending; the unconfirmed item is not auto-closed.
    expect(supp.handoff.status).toBe("pending");
    expect(supp.items.find((i: any) => i.action_item_id === ai03Id).status).toBe("open");

    // The parent package gains no new acknowledgment and stays acknowledged with the same version.
    const parent = (await app.inject({ method: "GET", url: `/api/handoffs/${parentId}` })).json();
    expect(parent.handoff.status).toBe("acknowledged");
    const parentItemAcks = parent.acknowledgments.filter((a: any) => a.action_item_id === ai03Id);
    expect(parentItemAcks).toHaveLength(0);
  });

  it("acknowledging with the current version succeeds and writes exactly one row", async () => {
    const { suppId, ai03Id } = await createSuppWithAi03();
    const res = await app.inject({
      method: "POST",
      url: `/api/handoffs/${suppId}/items/${ai03Id}/acknowledge`,
      headers: { "content-type": "application/json" },
      payload: { confirmed_by: "接班人", idempotency_key: "ok-key", expected_version: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().alreadyExisted).toBe(false);

    const detail = (await app.inject({ method: "GET", url: `/api/handoffs/${suppId}` })).json();
    expect(detail.acknowledgments.filter((a: any) => a.action_item_id === ai03Id)).toHaveLength(1);
  });
});
