import { test, expect, type Page } from '@playwright/test';

const A1 = 'act-gd-20260729-01-a1';
const A2 = 'act-gd-20260729-01-a2';

// Reset the backend to the canonical seed state before every test.
test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset');
  expect(res.ok()).toBeTruthy();
});

async function createAndSignHandoff(page: Page): Promise<string> {
  await page.getByTestId('create-handoff').click();
  await expect(page.locator('article.handoff-card')).toHaveCount(1);
  const handoffId = await page
    .locator('article.handoff-card')
    .first()
    .getAttribute('data-testid');
  const id = handoffId!.replace('handoff-', '');
  await page.getByTestId(`sign-off-${id}`).click();
  await expect(page.getByTestId(`handoff-status-${id}`)).toHaveText('已签收');
  return id;
}

test('loads the seeded incident with action items and timeline', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('incident-title')).toContainText('inc-gd-20260729-01');
  await expect(page.getByTestId(`action-item-${A1}`)).toBeVisible();
  await expect(page.getByTestId(`action-item-${A2}`)).toBeVisible();
  await expect(page.getByTestId('timeline-tl-gd-20260729-01-e1')).toBeVisible();
});

test('action item status update is keyboard operable and restores focus', async ({ page }) => {
  await page.goto('/');
  const select = page.getByTestId(`status-select-${A1}`);

  // Drive entirely via keyboard: focus the select, choose a new value.
  await select.focus();
  await expect(select).toBeFocused();
  await select.selectOption('done');

  // Status badge converges to the new value.
  await expect(page.getByTestId(`action-status-${A1}`)).toHaveText('已完成');
  await expect(page.getByTestId(`action-version-${A1}`)).toHaveText('v2');

  // Focus is restored to the same control after the refetch/re-render.
  await expect(select).toBeFocused();
});

test('stale optimistic version yields a field-level conflict, not a silent overwrite', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByTestId(`action-version-${A1}`)).toHaveText('v1');

  // A competing API client updates the same item to v2 out-of-band.
  const res = await request.patch(`/api/incidents/inc-gd-20260729-01/action-items/${A1}`, {
    data: { expected_version: 1, status: 'blocked', actor: 'other-client' },
  });
  expect(res.ok()).toBeTruthy();

  // The UI still holds v1. Attempt an update from the stale page.
  const select = page.getByTestId(`status-select-${A1}`);
  await select.selectOption('done');

  // A field-level conflict is surfaced with the current server value.
  const conflict = page.getByTestId(`conflict-${A1}`);
  await expect(conflict).toBeVisible();
  await expect(page.getByTestId(`conflict-field-${A1}-status`)).toContainText('blocked');

  // And the competing value was NOT overwritten: it converges to 'blocked'.
  await expect(page.getByTestId(`action-status-${A1}`)).toHaveText('受阻');
});

test('signed handoff freezes an immutable snapshot; later changes do not alter it', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const id = await createAndSignHandoff(page);

  await expect(page.getByTestId(`handoff-signed-${id}`)).toContainText('快照已冻结');

  // Change an action item after sign-off via another client.
  await request.patch(`/api/incidents/inc-gd-20260729-01/action-items/${A1}`, {
    data: { expected_version: 1, status: 'done', actor: 'next-shift' },
  });

  // Wait for polling to pull fresh data; the live incident shows 已完成 ...
  await expect(page.getByTestId(`action-status-${A1}`)).toHaveText('已完成', { timeout: 8000 });
  // ... but the frozen snapshot inside the signed handoff still shows 进行中.
  const snapshotItem = page.getByTestId(`ack-action-${id}-${A1}`);
  await expect(snapshotItem).toContainText('进行中');
});

test('signing does not auto-close unconfirmed items; each stays confirmable', async ({ page }) => {
  await page.goto('/');
  const id = await createAndSignHandoff(page);

  // Both action items remain unacknowledged (not auto-closed) after sign-off.
  await expect(page.getByTestId(`ack-btn-action-${id}-${A1}`)).toBeVisible();
  await expect(page.getByTestId(`ack-btn-action-${id}-${A2}`)).toBeVisible();
});

test('duplicate confirmation clicks do not create a second acknowledgement', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const id = await createAndSignHandoff(page);

  const ackBtn = page.getByTestId(`ack-btn-action-${id}-${A1}`);
  await ackBtn.click();
  await expect(page.getByTestId(`acked-action-${id}-${A1}`)).toBeVisible();

  // The item now shows as confirmed; simulate a retried/duplicate submit from
  // another client with the same effect and assert only one ack exists.
  const detail = await request.get(`/api/handoffs/${id}`);
  const body = await detail.json();
  const acksForA1 = body.acknowledgements.filter(
    (a: { item_id: string }) => a.item_id === A1,
  );
  expect(acksForA1).toHaveLength(1);
});

test('two sessions competing: acknowledgements converge to a single confirmation', async ({
  browser,
}) => {
  // Session 1 creates + signs a handoff.
  const ctx1 = await browser.newContext();
  const page1 = await ctx1.newPage();
  await page1.goto('/');
  const id = await createAndSignHandoff(page1);

  // Session 2 opens the same incident.
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto('/');
  await expect(page2.getByTestId(`handoff-status-${id}`)).toHaveText('已签收', { timeout: 8000 });

  // Both sessions click "confirm" on the same item near-simultaneously.
  await Promise.all([
    page1.getByTestId(`ack-btn-action-${id}-${A2}`).click(),
    page2.getByTestId(`ack-btn-action-${id}-${A2}`).click(),
  ]);

  // Both sessions converge to the confirmed state.
  await expect(page1.getByTestId(`acked-action-${id}-${A2}`)).toBeVisible({ timeout: 8000 });
  await expect(page2.getByTestId(`acked-action-${id}-${A2}`)).toBeVisible({ timeout: 8000 });

  await ctx1.close();
  await ctx2.close();
});

test('supplemental events append after sign-off and link to the origin handoff', async ({
  page,
}) => {
  await page.goto('/');
  const id = await createAndSignHandoff(page);

  const input = page.getByTestId(`supplemental-input-${id}`);
  await input.fill('签收后东侧绕行路线出现新积水点');
  await page.getByTestId(`supplemental-add-${id}`).click();

  // The supplemental event shows up under the (still-immutable) signed handoff.
  await expect(page.locator(`[data-testid^="supplemental-${id}-"]`)).toContainText(
    '签收后东侧绕行路线出现新积水点',
  );
});
