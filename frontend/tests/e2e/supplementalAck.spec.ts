import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { resetDatabase } from "../reset-db";

const INCIDENT_URL = "/?id=inc-gd-20260729-01";
const INCIDENT_API = "http://localhost:4000/api/incidents/inc-gd-20260729-01";
const AI_03 = "ai-gd-20260729-03";
const EV_03 = "ev-gd-20260729-03";

async function openPage(context: BrowserContext, actor: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(INCIDENT_URL);
  await expect(page.locator(".incident-title")).toBeVisible();
  await page.locator("#actor-input").fill(actor);
  return page;
}

async function createAndSign(page: Page) {
  await page.getByRole("button", { name: "新建交接包" }).click();
  await page.getByRole("button", { name: "签收并固化快照" }).click();
  await expect(page.getByText(/已签收快照（不可修改）/)).toBeVisible();
}

async function setupSupplementalWithAi03(page: Page) {
  await createAndSign(page);

  const actionSection = page.locator('section[aria-label="行动项"]');
  await actionSection.getByLabel("新行动项标题").fill("东侧绕行路线重新开放");
  await actionSection.getByLabel("新行动项责任方").fill("交通协调组");
  await actionSection.getByLabel("新行动项稳定 ID").fill(AI_03);
  await actionSection.getByRole("button", { name: "新增" }).click();
  await expect(page.getByText(/已新增行动项/)).toBeVisible();

  const timelineSection = page.locator('section[aria-label="证据时间线"]');
  await timelineSection.locator("select").first().selectOption("road_reopened");
  await timelineSection
    .getByLabel("事件描述", { exact: true })
    .fill("东侧绕行路线重新开放，主路恢复通行。");
  await timelineSection.getByLabel("责任方", { exact: true }).fill("交通协调组");
  await timelineSection.getByLabel("时间线稳定 ID").fill(EV_03);
  await timelineSection.getByRole("button", { name: "追加" }).click();
  await expect(page.getByText(/时间线事件已追加/)).toBeVisible();

  await page.getByRole("button", { name: "生成补充交接包" }).click();
  await expect(
    page.locator(".toast", { hasText: "补充交接包已生成" }),
  ).toBeVisible();

  const detail = await page.request
    .get(INCIDENT_API)
    .then((r) => r.json());
  const signed = detail.handoffs
    .filter((h: { status: string }) => h.status === "signed")
    .pop();
  const shDetail = await page.request
    .get(`http://localhost:4000/api/handoffs/${signed.id}`)
    .then((r) => r.json());
  return {
    parentId: signed.id as string,
    shId: shDetail.supplemental_handoff.id as string,
  };
}

test.describe("补充包逐项确认：双浏览器并发 + 旧版本冲突 + 幂等重试", () => {
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;

  test.beforeAll(async ({ browser }) => {
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await openPage(contextA, "接班人甲");
  });

  test.beforeEach(async () => {
    await resetDatabase();
    await pageA.goto(INCIDENT_URL);
    await expect(pageA.locator(".incident-title")).toBeVisible();
    await pageA.locator("#actor-input").fill("接班人甲");
  });

  test.afterAll(async () => {
    await resetDatabase();
    await contextA.close();
    await contextB.close();
  });

  test("旧版本确认返回字段级冲突，有效确认成功，相同幂等键重试只产生一条确认和审计", async () => {
    const { parentId, shId } = await setupSupplementalWithAi03(pageA);

    const patchRes = await pageA.request.patch(
      `http://localhost:4000/api/action-items/${AI_03}`,
      {
        headers: { "Content-Type": "application/json" },
        data: {
          expectedVersion: 1,
          actor: "赵六",
          patch: { status: "done", detail: "道路已开放，确认完成。" },
        },
      },
    );
    expect(patchRes.status()).toBe(200);

    const staleRes = await contextA.request.post(
      `http://localhost:4000/api/supplemental-handoffs/${shId}/acknowledgements`,
      {
        headers: { "Content-Type": "application/json" },
        data: {
          item_type: "action_item",
          item_id: AI_03,
          acknowledged_by: "接班人甲",
          expected_version: 1,
        },
      },
    );
    expect(staleRes.status()).toBe(409);
    const staleBody = await staleRes.json();
    expect(staleBody.error).toBe("optimistic_lock_conflict");
    expect(staleBody.currentVersion).toBe(2);
    expect(staleBody.current.status).toBe("done");
    const statusConflict = staleBody.conflicts.find(
      (c: { field: string }) => c.field === "status",
    );
    expect(statusConflict.base).toBe("open");
    expect(statusConflict.current).toBe("done");
    const detailConflict = staleBody.conflicts.find(
      (c: { field: string }) => c.field === "detail",
    );
    expect(detailConflict.current).toBe("道路已开放，确认完成。");

    const idemKey = "supp-ack-dual-" + Date.now();
    const okRes = await contextB.request.post(
      `http://localhost:4000/api/supplemental-handoffs/${shId}/acknowledgements`,
      {
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idemKey,
        },
        data: {
          item_type: "action_item",
          item_id: AI_03,
          acknowledged_by: "接班人乙",
          expected_version: 2,
        },
      },
    );
    expect(okRes.status()).toBe(201);
    const okBody = await okRes.json();
    const ackId = okBody.acknowledgement.id;
    expect(okBody.acknowledgement.supplemental_handoff_id).toBe(shId);
    expect(okBody.acknowledgement.acked_version).toBe(2);

    const retryRes = await contextB.request.post(
      `http://localhost:4000/api/supplemental-handoffs/${shId}/acknowledgements`,
      {
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idemKey,
        },
        data: {
          item_type: "action_item",
          item_id: AI_03,
          acknowledged_by: "接班人乙",
          expected_version: 2,
        },
      },
    );
    expect(retryRes.status()).toBe(200);
    const retryBody = await retryRes.json();
    expect(retryBody.acknowledgement.id).toBe(ackId);
    expect(retryBody.replayed).toBe(true);

    const staleRetry = await contextA.request.post(
      `http://localhost:4000/api/supplemental-handoffs/${shId}/acknowledgements`,
      {
        headers: { "Content-Type": "application/json" },
        data: {
          item_type: "action_item",
          item_id: AI_03,
          acknowledged_by: "接班人甲",
          expected_version: 2,
        },
      },
    );
    expect(staleRetry.status()).toBe(200);
    expect((await staleRetry.json()).acknowledgement.id).toBe(ackId);

    const acks = await pageA.request
      .get(
        `http://localhost:4000/api/handoffs/${parentId}`,
      )
      .then((r) => r.json());
    expect(acks.supplemental_acknowledgements).toHaveLength(1);
    expect(acks.acknowledgements).toHaveLength(0);

    const allAudits = await pageA.request
      .get(
        "http://localhost:4000/api/incidents/inc-gd-20260729-01/audit?limit=200",
      )
      .then((r) => r.json());
    const ackAudits = allAudits.audit_events.filter(
      (e: { event_type: string; payload: { supplemental_handoff_id?: string } }) =>
        e.event_type === "supplemental_acknowledgement.created" &&
        e.payload?.supplemental_handoff_id === shId,
    );
    expect(ackAudits).toHaveLength(1);

    const itemAfter = await pageA.request
      .get(INCIDENT_API)
      .then((r) => r.json());
    const ai03 = itemAfter.action_items.find(
      (a: { id: string }) => a.id === AI_03,
    );
    expect(ai03.status).toBe("done");
  });

  test("UI 展示字段级冲突，重新加载后收敛；刷新后焦点回到原确认项", async () => {
    const { shId } = await setupSupplementalWithAi03(pageA);

    await pageA.request.patch(
      `http://localhost:4000/api/action-items/${AI_03}`,
      {
        headers: { "Content-Type": "application/json" },
        data: {
          expectedVersion: 1,
          actor: "赵六",
          patch: { status: "blocked", detail: "现场仍有积水，暂缓。" },
        },
      },
    );

    await pageA.route("**/api/incidents/**", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/events")) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.json();
      if (body.action_items) {
        body.action_items = body.action_items.map(
          (a: { id: string; version: number; status: string; detail: string }) => {
            if (a.id === AI_03) {
              return { ...a, version: 1, status: "open", detail: "确认排水完成，道路恢复双向通行。" };
            }
            return a;
          },
        );
      }
      await route.fulfill({ response, body: JSON.stringify(body) });
    });

    await pageA.reload();
    await expect(pageA.locator(".incident-title")).toBeVisible();

    const diffChanges = pageA.locator(".diff-changes");
    await expect(diffChanges.getByText("＋ 东侧绕行路线重新开放")).toBeVisible();

    const ai03Item = diffChanges.locator(".diff-item", {
      hasText: "＋ 东侧绕行路线重新开放",
    });
    const ackButton = ai03Item.getByRole("button", { name: /确认补充包项/ });
    await ackButton.click();

    const conflictBox = ai03Item.locator(".conflict-box");
    await expect(conflictBox).toBeVisible();
    await expect(conflictBox.getByText("字段级冲突")).toBeVisible();
    await expect(conflictBox).toContainText("暂缓");
    await expect(conflictBox).toContainText("受阻");

    await pageA.unroute("**/api/incidents/**");
    await conflictBox.getByRole("button", { name: "重新加载最新状态" }).click();
    await expect(conflictBox).toHaveCount(0);

    await expect(ackButton).toBeVisible();
    await ackButton.click();
    await expect(ackButton).toContainText("已确认");

    await pageA.reload();
    await expect(pageA.locator(".incident-title")).toBeVisible();

    await expect(
      pageA.locator(".diff-changes").getByText("＋ 东侧绕行路线重新开放"),
    ).toBeVisible();

    const restoredItem = pageA
      .locator(".diff-changes")
      .locator(".diff-item", { hasText: "＋ 东侧绕行路线重新开放" });
    const restoredButton = restoredItem.getByRole("button", {
      name: /确认补充包项/,
    });
    await expect(restoredButton).toBeFocused();
    await expect(restoredButton).toContainText("已确认");

    void shId;
  });
});
