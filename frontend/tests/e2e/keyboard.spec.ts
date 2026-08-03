import { test, expect, type Page, type BrowserContext } from "@playwright/test";

const A1 = "act-gd-20260729-01-a1";

async function openPage(context: BrowserContext, actor: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/?id=inc-gd-20260729-01");
  await expect(page.locator(".incident-title")).toBeVisible();
  await page.locator("#actor-input").fill(actor);
  return page;
}

test.describe("键盘操作与焦点恢复", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await openPage(context, "键盘测试员");
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("Ctrl+K 聚焦并选中值班人输入框，可直接改名", async () => {
    await page.keyboard.press("Control+k");
    await expect(page.locator("#actor-input")).toBeFocused();
    await page.keyboard.type("接班人-丙");
    await expect(page.locator("#actor-input")).toHaveValue("接班人-丙");
  });

  test("Tab 键可到达行动项状态选择框", async () => {
    await page.locator("#actor-input").focus();
    let reached = false;
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      const id = await page.evaluate(
        () => document.activeElement?.id ?? ""
      );
      if (id === `status-${A1}`) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
  });

  test("用键盘新建交接包并签收：Enter 激活按钮", async () => {
    await page
      .getByRole("button", { name: "新建交接包" })
      .focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "签收并固化快照" })
    ).toBeVisible();

    await page
      .getByRole("button", { name: "签收并固化快照" })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/已签收快照（不可修改）/)).toBeVisible({
      timeout: 10000,
    });
  });

  test("更新行动项后焦点恢复到状态选择框", async () => {
    const select = page.locator(`#status-${A1}`);
    await select.focus();
    const current = await select.inputValue();
    const next = current === "done" ? "in_progress" : "done";
    await select.selectOption(next);
    await expect(select).toBeFocused({ timeout: 5000 });
    await expect(select).toHaveValue(next);
  });

  test("逐项确认按钮可通过键盘激活，且激活后焦点恢复", async () => {
    const item = page
      .locator(".item")
      .filter({ hasText: "确认临时搭建物撤离结果" });
    const btn = item.getByRole("button", { name: /确认该项|已确认/ });
    await btn.focus();
    await page.keyboard.press("Enter");
    await expect(item.getByRole("button", { name: /已确认/ })).toBeVisible({
      timeout: 8000,
    });
    await expect(btn).toBeFocused({ timeout: 5000 });
  });
});
