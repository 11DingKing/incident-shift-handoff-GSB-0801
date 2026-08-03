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
const AI_TEMP = "ai-gd-20260729-temp-structure";

describe("Supplementary handoff packages", () => {
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

  async function setupAcknowledgedParent(): Promise<string> {
    await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT}/handoffs`,
      headers: { "content-type": "application/json" },
      payload: {
        handoff_id: "hnd-parent",
        from_shift: "A",
        to_shift: "B",
        summary: "initial",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/handoffs/hnd-parent/acknowledge",
      headers: { "content-type": "application/json" },
      payload: { confirmed_by: "接班人", idempotency_key: "parent-pkg" },
    });
    return "hnd-parent";
  }

  it("snapshots only new/changed items with per-field diffs; new timeline event included", async () => {
    const parentId = await setupAcknowledgedParent();

    // Add a new action item ai-03 after sign-off.
    const newAi = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT}/action-items`,
      headers: { "content-type": "application/json", "x-actor": "夜班" },
      payload: {
        title: "东侧绕行路线重新开放",
        description: "积水消退，评估恢复通行",
        status: "open",
        owner: "应急协调组-李工",
      },
    });
    expect(newAi.statusCode).toBe(200);
    const ai03 = newAi.json().action_item_id;

    // Update an existing item (status change) with correct version.
    const items = (
      await app.inject({
        method: "GET",
        url: `/api/incidents/${INCIDENT}/action-items`,
      })
    ).json();
    const route = items.find((i: any) => i.action_item_id === AI_ROUTE);
    await app.inject({
      method: "PATCH",
      url: `/api/action-items/${AI_ROUTE}`,
      headers: { "content-type": "application/json", "x-actor": "夜班" },
      payload: { status: "done", expected_version: route.version },
    });

    // Add new timeline event ev-03.
    await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT}/timeline`,
      headers: { "content-type": "application/json", "x-actor": "夜班" },
      payload: {
        event_id: "ev-gd-20260729-03",
        event_type: "update",
        summary: "东侧绕行路线重新开放",
        actor: "夜班-赵六",
      },
    });

    const supp = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT}/handoffs/supplementary`,
      headers: { "content-type": "application/json" },
      payload: {
        handoff_id: "hnd-supp-1",
        parent_handoff_id: parentId,
        from_shift: "夜班",
        to_shift: "早班",
        summary: "签收后变化",
      },
    });
    expect(supp.statusCode).toBe(200);
    const body = supp.json();
    expect(body.handoff.parent_handoff_id).toBe(parentId);
    expect(body.handoff.handoff_kind).toBe("supplementary");
    expect(body.created).toBe(true);

    // Only the new item and the changed item are snapshotted (the unchanged temp item is not).
    const snapIds = body.items.map((i: any) => i.action_item_id).sort();
    expect(snapIds).toEqual([ai03, AI_ROUTE].sort());
    expect(
      body.items.find((i: any) => i.action_item_id === AI_TEMP),
    ).toBeUndefined();

    // Only the new timeline event is snapshotted.
    expect(body.timeline).toHaveLength(1);
    expect(body.timeline[0].event_id).toBe("ev-gd-20260729-03");

    // Diffs: ai03 added, route status modified, ev-03 added.
    const diffs = body.diffs;
    const ai03Added = diffs.find(
      (d: any) => d.ref_id === ai03 && d.change_kind === "added",
    );
    expect(ai03Added).toBeTruthy();
    const statusDiff = diffs.find(
      (d: any) => d.ref_id === AI_ROUTE && d.field === "status",
    );
    expect(statusDiff).toBeTruthy();
    expect(statusDiff.old_value).toBe("in_progress");
    expect(statusDiff.new_value).toBe("done");
    const evDiff = diffs.find((d: any) => d.ref_id === "ev-gd-20260729-03");
    expect(evDiff).toBeTruthy();
  });

  it("does not modify the parent package owner/status/version/acknowledgments", async () => {
    const parentId = await setupAcknowledgedParent();
    const before = (
      await app.inject({ method: "GET", url: `/api/handoffs/${parentId}` })
    ).json();

    // Make a change then create supplementary.
    const items = (
      await app.inject({
        method: "GET",
        url: `/api/incidents/${INCIDENT}/action-items`,
      })
    ).json();
    const route = items.find((i: any) => i.action_item_id === AI_ROUTE);
    await app.inject({
      method: "PATCH",
      url: `/api/action-items/${AI_ROUTE}`,
      headers: { "content-type": "application/json" },
      payload: { status: "done", expected_version: route.version },
    });
    await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT}/handoffs/supplementary`,
      headers: { "content-type": "application/json" },
      payload: {
        handoff_id: "hnd-supp-2",
        parent_handoff_id: parentId,
        from_shift: "X",
        to_shift: "Y",
        summary: "",
      },
    });

    const after = (
      await app.inject({ method: "GET", url: `/api/handoffs/${parentId}` })
    ).json();
    expect(after.handoff.version).toBe(before.handoff.version);
    expect(after.handoff.status).toBe("acknowledged");
    expect(after.handoff.acknowledged_by).toBe(before.handoff.acknowledged_by);
    // Parent snapshot items unchanged.
    expect(after.items).toEqual(before.items);
    // Parent acknowledgment count unchanged.
    expect(after.acknowledgments.length).toBe(before.acknowledgments.length);
  });

  it("rejects supplementary creation before parent is acknowledged (409)", async () => {
    await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT}/handoffs`,
      headers: { "content-type": "application/json" },
      payload: {
        handoff_id: "hnd-unacked",
        from_shift: "A",
        to_shift: "B",
        summary: "",
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT}/handoffs/supplementary`,
      headers: { "content-type": "application/json" },
      payload: {
        handoff_id: "hnd-supp-x",
        parent_handoff_id: "hnd-unacked",
        from_shift: "X",
        to_shift: "Y",
        summary: "",
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it("is idempotent: same idempotency key returns same package, no extra diffs/audit", async () => {
    const parentId = await setupAcknowledgedParent();
    const items = (
      await app.inject({
        method: "GET",
        url: `/api/incidents/${INCIDENT}/action-items`,
      })
    ).json();
    const route = items.find((i: any) => i.action_item_id === AI_ROUTE);
    await app.inject({
      method: "PATCH",
      url: `/api/action-items/${AI_ROUTE}`,
      headers: { "content-type": "application/json" },
      payload: { status: "done", expected_version: route.version },
    });

    const payload = {
      handoff_id: "hnd-supp-idem",
      parent_handoff_id: parentId,
      from_shift: "X",
      to_shift: "Y",
      summary: "",
      idempotency_key: "same-supp-key",
    };
    const r1 = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT}/handoffs/supplementary`,
      headers: { "content-type": "application/json" },
      payload,
    });
    const r2 = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT}/handoffs/supplementary`,
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.json().handoff.handoff_id).toBe(r2.json().handoff.handoff_id);
    expect(r1.json().created).toBe(true);
    expect(r2.json().created).toBe(false);

    // Exactly one child package, one set of diffs, one audit event.
    const children = (
      await app.inject({
        method: "GET",
        url: `/api/incidents/${INCIDENT}/handoffs`,
      })
    )
      .json()
      .filter((h: any) => h.parent_handoff_id === parentId);
    expect(children).toHaveLength(1);

    const detail = (
      await app.inject({ method: "GET", url: "/api/handoffs/hnd-supp-idem" })
    ).json();
    const diffCount = detail.diffs.length;
    expect(diffCount).toBe(r1.json().diffs.length);

    const audit = (
      await app.inject({
        method: "GET",
        url: `/api/incidents/${INCIDENT}/audit`,
      })
    )
      .json()
      .filter((a: any) => a.action === "supplementary_handoff_created");
    expect(audit).toHaveLength(1);
  });

  it("concurrent calls with same idempotency key produce exactly one package and one diff set", async () => {
    const parentId = await setupAcknowledgedParent();
    const payload = {
      parent_handoff_id: parentId,
      from_shift: "X",
      to_shift: "Y",
      summary: "",
      idempotency_key: "concurrent-supp-key",
    };
    const call = () =>
      app.inject({
        method: "POST",
        url: `/api/incidents/${INCIDENT}/handoffs/supplementary`,
        headers: { "content-type": "application/json" },
        payload,
      });
    const [c1, c2] = await Promise.all([call(), call()]);
    expect([c1.statusCode, c2.statusCode].every((s) => s === 200)).toBe(true);
    const ids = new Set([
      c1.json().handoff.handoff_id,
      c2.json().handoff.handoff_id,
    ]);
    expect(ids.size).toBe(1);

    const children = (
      await app.inject({
        method: "GET",
        url: `/api/incidents/${INCIDENT}/handoffs`,
      })
    )
      .json()
      .filter((h: any) => h.parent_handoff_id === parentId);
    expect(children).toHaveLength(1);

    const audit = (
      await app.inject({
        method: "GET",
        url: `/api/incidents/${INCIDENT}/audit`,
      })
    )
      .json()
      .filter((a: any) => a.action === "supplementary_handoff_created");
    expect(audit).toHaveLength(1);
  });
});
