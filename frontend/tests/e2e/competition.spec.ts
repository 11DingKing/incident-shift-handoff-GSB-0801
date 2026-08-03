import { test, expect, type Page, type BrowserContext } from "@playwright/test";

const INCIDENT_URL = "/?id=inc-gd-20260729-01";
const A1 = "act-gd-20260729-01-a1";
const A2 = "act-gd-20260729-01-a2";

async function openSession(
  context: BrowserContext,
  actor: string
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(INCIDENT_URL);
  await expect(page.locator(".incident-title")).toBeVisible();
  await page.locator("#actor-input").fill(actor);
  return page;
}

async function createAndSignHandoff(page: Page) {
  await page
    .getByRole("button", { name: "新建交接包" })
    .click();
  const signButton = page.getByRole("button", { name: "签收并固化快照" });
  await expect(signButton).toBeVisible();
  await signButton.click();
  await expect(
    page.getByText(/已签收快照（不可修改）/)
  ).toBeVisible();
}

test.describe("双会话交叉竞争", () => {
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;

  test.beforeAll(async ({ browser }) => {
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await openSession(contextA, "值班员甲");
    pageB = await openSession(contextB, "值班员乙");
  });

  test.afterAll(async () => {
    await contextA.close();
    await contextB.close();
  });

  test("一个会话更新行动项，另一个会话通过实时推送最终收敛", async () => {
    const selectA = pageA.locator(`#status-${A1}`);
    const selectB = pageB.locator(`#status-${A1}`);

    await selectA.selectOption("done");
    await expect(selectB).toHaveValue("done", { timeout: 15000 });

    await selectB.selectOption("blocked");
    await expect(selectA).toHaveValue("blocked", { timeout: 15000 });

    await selectA.selectOption("in_progress");
    await expect(selectB).toHaveValue("in_progress", { timeout: 15000 });
  });

  test("并发逐项确认同一事项：只产生一份确认，重复提交幂等", async () => {
    await createAndSignHandoff(pageA);
    await expect(
      pageB.getByText(/已签收快照（不可修改）/)
    ).toBeVisible({ timeout: 10000 });

    const confirmA = pageA
      .locator(".item")
      .filter({ hasText: "复核东侧绕行路线" })
      .getByRole("button", { name: "确认该项" });
    const confirmB = pageB
      .locator(".item")
      .filter({ hasText: "复核东侧绕行路线" })
      .getByRole("button", { name: "确认该项" });

    await Promise.all([confirmA.first().click(), confirmB.first().click()]);

    await expect(
      pageA
        .locator(".item")
        .filter({ hasText: "复核东侧绕行路线" })
        .getByRole("button", { name: /已确认/ })
    ).toBeVisible({ timeout: 8000 });
    await expect(
      pageB
        .locator(".item")
        .filter({ hasText: "复核东侧绕行路线" })
        .getByRole("button", { name: /已确认/ })
    ).toBeVisible({ timeout: 8000 });

    const res = await pageA.request.get(
      "http://localhost:4000/api/incidents/inc-gd-20260729-01"
    );
    const body = await res.json();
    const handoffId = body.handoffs.find(
      (h: { status: string }) => h.status === "signed"
    ).id;
    const detail = await pageA.request.get(
      `http://localhost:4000/api/handoffs/${handoffId}`
    );
    const detailBody = await detail.json();
    const acks = detailBody.acknowledgements.filter(
      (a: { item_id: string }) => a.item_id === A1
    );
    expect(acks).toHaveLength(1);
  });

  test("签收后更新行动项追加补充事件，快照视图保持不变", async () => {
    const selectA = pageA.locator(`#status-${A2}`);
    await selectA.selectOption("in_progress");

    await expect(
      pageB.getByText(/签收后补充事件/)
    ).toBeVisible({ timeout: 10000 });
    await expect(
      pageB.getByText(/行动项「确认临时搭建物撤离结果」更新/)
    ).toBeVisible({ timeout: 10000 });

    await expect(
      pageA.locator(`#status-${A2}`)
    ).toHaveValue("in_progress");

    const snapshotBadge = pageA
      .locator(".snapshot")
      .locator(".item")
      .filter({ hasText: "确认临时搭建物撤离结果" });
    await expect(snapshotBadge).toContainText("待处理");
  });

  test("旧乐观版本提交返回字段级冲突而非静默覆盖", async () => {
    await pageB.route("**/api/incidents/**/events", (route) => route.abort());
    let firstGet = true;
    await pageB.route(
      "**/api/incidents/inc-gd-20260729-01",
      (route) => {
        if (firstGet) {
          firstGet = false;
          return route.continue();
        }
        return new Promise(() => {});
      }
    );
    await pageB.reload();
    await pageB.locator("#actor-input").fill("值班员乙");

    await pageA.locator(`#status-${A1}`).selectOption("done");
    await expect(pageA.locator(`#status-${A1}`)).toHaveValue("done");

    await pageB.locator(`#status-${A1}`).selectOption("blocked");

    const alert = pageB.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 8000 });
    await expect(alert).toContainText("字段级冲突");
    await expect(alert).toContainText("status");
    await expect(alert).toContainText("已完成");
    await expect(alert).toContainText("受阻");
    await expect(alert).toContainText(/服务器当前版本：v\d+/);
    const versionText = await alert.textContent();
    expect(versionText).toMatch(/服务器当前版本：v5\b/);

    await pageB.unroute("**/api/incidents/inc-gd-20260729-01");
    await pageB.unroute("**/api/incidents/**/events");
    await alert.getByRole("button", { name: "重新加载最新状态" }).click();
    await expect(pageB.locator(`#status-${A1}`)).toHaveValue("done", {
      timeout: 10000,
    });
  });
});
