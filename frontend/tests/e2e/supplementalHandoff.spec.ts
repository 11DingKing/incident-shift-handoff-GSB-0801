import { test, expect, type Page, type BrowserContext } from "@playwright/test";

const INCIDENT_URL = "/?id=inc-gd-20260729-01";
const EV_03 = "ev-gd-20260729-03";
const AI_03 = "ai-gd-20260729-03";
const A1 = "act-gd-20260729-01-a1";

async function openPage(context: BrowserContext, actor: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(INCIDENT_URL);
  await expect(page.locator(".incident-title")).toBeVisible();
  await page.locator("#actor-input").fill(actor);
  return page;
}

async function createAndSign(page: Page) {
  await page.getByRole("button", { name: "新建交接包" }).click();
  await page
    .getByRole("button", { name: "签收并固化快照" })
    .click();
  await expect(page.getByText(/已签收快照（不可修改）/)).toBeVisible();
}

test.describe("补充交接包与逐字段差异", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await openPage(context, "交班人");
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("签收后追加稳定ID事件/行动项，生成补充包并并排展示父快照与逐字段差异", async () => {
    await createAndSign(page);

    const incident = await page.request
      .get("http://localhost:4000/api/incidents/inc-gd-20260729-01")
      .then((r) => r.json());
    const a1 = incident.action_items.find(
      (a: { id: string }) => a.id === A1
    );
    const nextStatus = a1.status === "done" ? "blocked" : "done";
    await page.locator("#status-" + A1).selectOption(nextStatus);
    await expect(page.locator("#status-" + A1)).toHaveValue(nextStatus);

    const timelineSection = page.locator('section[aria-label="证据时间线"]');
    const kindSelect = timelineSection.locator("select").first();
    await kindSelect.selectOption("road_reopened");
    await timelineSection.getByLabel("事件描述", { exact: true }).fill("东侧绕行路线重新开放，主路恢复通行。");
    await timelineSection.getByLabel("责任方", { exact: true }).fill("交通协调组");
    await timelineSection.getByLabel("时间线稳定 ID").fill(EV_03);
    await timelineSection.getByRole("button", { name: "追加" }).click();
    await expect(page.getByText(/时间线事件已追加/)).toBeVisible();

    const actionSection = page.locator('section[aria-label="行动项"]');
    await actionSection.getByLabel("新行动项标题").fill("东侧绕行路线重新开放");
    await actionSection.getByLabel("新行动项责任方").fill("交通协调组");
    await actionSection.getByLabel("新行动项稳定 ID").fill(AI_03);
    await actionSection.getByRole("button", { name: "新增" }).click();
    await expect(page.getByText(/已新增行动项/)).toBeVisible();

    await page.getByRole("button", { name: "生成补充交接包" }).click();
    await expect(
      page.locator(".toast", { hasText: "补充交接包已生成" })
    ).toBeVisible();

    const diffCol = page.locator(".diff-changes");
    await expect(diffCol.getByText("新增行动项")).toBeVisible();
    await expect(diffCol.getByText("＋ 东侧绕行路线重新开放")).toBeVisible();
    await expect(diffCol.getByText(/ai-gd-20260729-03/)).toBeVisible();

    await expect(diffCol.getByText("变化行动项（逐字段）")).toBeVisible();
    await expect(diffCol.getByText(/v\d+\u2192v\d+/)).toBeVisible();
    await expect(
      diffCol.getByText("复核东侧绕行路线", { exact: false })
    ).toBeVisible();

    await expect(diffCol.getByText("新增时间线事件")).toBeVisible();
    await expect(
      diffCol.getByText("道路恢复通行", { exact: false })
    ).toBeVisible();
    await expect(
      diffCol.getByText("东侧绕行路线重新开放，主路恢复通行。")
    ).toBeVisible();

    const parentCol = page.locator(".diff-col").first();
    await expect(parentCol).toContainText("复核东侧绕行路线");
    await expect(parentCol).toContainText("进行中");

    const apiDetail = await page.request.get(
      "http://localhost:4000/api/incidents/inc-gd-20260729-01"
    );
    const body = await apiDetail.json();
    const signed = body.handoffs
      .filter((h: { status: string }) => h.status === "signed")
      .pop();
    const frozenA1 = signed.snapshot.action_items.find(
      (a: { id: string }) => a.id === A1
    );
    expect(frozenA1.status).toBe(a1.status);
    const frozenCount = signed.snapshot.action_items.length;
    expect(frozenCount).toBe(2);

    const shRes = await page.request.get(
      `http://localhost:4000/api/handoffs/${signed.id}`
    );
    const shBody = await shRes.json();
    expect(shBody.supplemental_handoff).toBeTruthy();
    expect(shBody.supplemental_handoff.diff.added_action_items).toHaveLength(1);
    expect(shBody.supplemental_handoff.diff.changed_action_items).toHaveLength(1);
    expect(shBody.supplemental_handoff.diff.added_timeline_events).toHaveLength(1);
  });

  test("重复生成与同幂等键重试只返回同一个补充包", async () => {
    await createAndSign(page);
    await page.getByRole("button", { name: "生成补充交接包" }).click();
    await expect(
      page.locator(".toast", { hasText: "补充交接包已生成" }).last()
    ).toBeVisible();
    await expect(page.locator(".badge", { hasText: /^已生成 sh-/ })).toBeVisible();

    const detail = await page.request
      .get("http://localhost:4000/api/incidents/inc-gd-20260729-01")
      .then((r) => r.json());
    const signed = detail.handoffs
      .filter((h: { status: string }) => h.status === "signed")
      .pop();
    const count = await page.request
      .get(`http://localhost:4000/api/handoffs/${signed.id}`)
      .then((r) => r.json());
    expect(count.supplemental_handoff).toBeTruthy();
    const existingId = count.supplemental_handoff.id;

    const r1 = await page.request.post(
      `http://localhost:4000/api/handoffs/${signed.id}/supplemental-handoff`,
      {
        headers: { "Idempotency-Key": "sh-e2e-1", "Content-Type": "application/json" },
        data: { actor: "接班人A" },
      }
    );
    const r2 = await page.request.post(
      `http://localhost:4000/api/handoffs/${signed.id}/supplemental-handoff`,
      {
        headers: { "Idempotency-Key": "sh-e2e-1", "Content-Type": "application/json" },
        data: { actor: "接班人A" },
      }
    );
    expect(r1.status()).toBe(200);
    expect(r2.status()).toBe(200);
    expect((await r1.json()).id).toBe((await r2.json()).id);
    expect((await r1.json()).id).toBe(existingId);
  });
});

test.describe("双会话并发生成补充包", () => {
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;

  test.beforeAll(async ({ browser }) => {
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await openPage(contextA, "值班员甲");
    pageB = await openPage(contextB, "值班员乙");
  });

  test.afterAll(async () => {
    await contextA.close();
    await contextB.close();
  });

  test("两个会话同时点击生成，只产生一个补充包", async () => {
    await createAndSign(pageA);
    await expect(pageB.getByText(/已签收快照（不可修改）/)).toBeVisible({
      timeout: 10000,
    });

    await pageA.getByLabel("新行动项标题").fill("并发场景新增");
    await pageA.getByLabel("新行动项责任方").fill("交通协调组");
    await pageA
      .locator('section[aria-label="行动项"]')
      .getByRole("button", { name: "新增" })
      .click();
    await expect(pageA.getByText(/已新增行动项/)).toBeVisible();
    await expect(pageB.getByText("并发场景新增")).toBeVisible({ timeout: 10000 });

    const [idA, idB] = await Promise.all([
      getSignedHandoffId(pageA),
      getSignedHandoffId(pageB),
    ]);
    expect(idA).toBe(idB);
    const [r1, r2] = await Promise.all([
      pageA.request.post(
        `http://localhost:4000/api/handoffs/${idA}/supplemental-handoff`,
        {
          headers: { "Content-Type": "application/json" },
          data: { actor: "甲" },
        }
      ),
      pageB.request.post(
        `http://localhost:4000/api/handoffs/${idB}/supplemental-handoff`,
        {
          headers: { "Content-Type": "application/json" },
          data: { actor: "乙" },
        }
      ),
    ]);
    const created = [r1.status(), r2.status()].filter((s) => s === 201);
    expect(created).toHaveLength(1);
    const j1 = await r1.json();
    const j2 = await r2.json();
    expect(j1.id).toBe(j2.id);

    const shId = j1.id;
    const handoffDetail = await pageA.request
      .get(`http://localhost:4000/api/handoffs/${idA}`)
      .then((r) => r.json());
    expect(handoffDetail.supplemental_handoff.id).toBe(shId);
    const allAudits = await pageA.request
      .get(
        `http://localhost:4000/api/incidents/inc-gd-20260729-01/audit?limit=100`
      )
      .then((r) => r.json());
    const shAudits = allAudits.audit_events.filter(
      (e: { event_type: string; handoff_id: string }) =>
        e.event_type === "supplemental_handoff.created" && e.handoff_id === idA
    );
    expect(shAudits).toHaveLength(1);

    expect(handoffDetail.supplemental_handoff.id).toBe(shId);
    await expect
      .poll(
        async () => {
          const d = await pageB.request
            .get(`http://localhost:4000/api/handoffs/${idB}`)
            .then((r) => r.json());
          return d.supplemental_handoff?.id ?? null;
        },
        { timeout: 10000 },
      )
      .toBe(shId);
  });
});

async function getSignedHandoffId(page: Page): Promise<string> {
  const detail = await page.request
    .get("http://localhost:4000/api/incidents/inc-gd-20260729-01")
    .then((r) => r.json());
  const signed = detail.handoffs
    .filter((h: { status: string }) => h.status === "signed")
    .pop();
  return signed.id;
}
