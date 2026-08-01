import { test, expect, type Page } from '@playwright/test';

const A1 = 'act-gd-20260729-01-a1';
const EV3 = 'ev-gd-20260729-03';
const AI3 = 'ai-gd-20260729-03';

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset');
  expect(res.ok()).toBeTruthy();
});

async function createAndSignHandoff(page: Page): Promise<string> {
  await page.getByTestId('create-handoff').click();
  await expect(page.locator('article.handoff-card')).toHaveCount(1);
  const raw = await page.locator('article.handoff-card').first().getAttribute('data-testid');
  const id = raw!.replace('handoff-', '');
  await page.getByTestId(`sign-off-${id}`).click();
  await expect(page.getByTestId(`handoff-status-${id}`)).toHaveText('已签收');
  return id;
}

test('creates a supplemental package showing parent snapshot and diff side by side', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const id = await createAndSignHandoff(page);

  // After sign-off: add ev-gd-20260729-03, ai-gd-20260729-03, and change a1.
  await request.post('/api/incidents/inc-gd-20260729-01/timeline', {
    data: {
      id: EV3,
      kind: 'road_reopen',
      description: '东侧绕行路线重新开放。',
      responsible_party: '交通协调组',
      occurred_at: '2026-07-29T06:00:00.000Z',
      actor: '交通协调组',
    },
  });
  await request.post('/api/incidents/inc-gd-20260729-01/action-items', {
    data: {
      id: AI3,
      title: '复核重新开放后的通行能力',
      status: 'open',
      responsible_party: '交通协调组',
      occurred_at: '2026-07-29T06:05:00.000Z',
      actor: '交通协调组',
    },
  });
  await request.patch(`/api/incidents/inc-gd-20260729-01/action-items/${A1}`, {
    data: { expected_version: 1, status: 'done', actor: '交通协调组' },
  });

  // Create the supplemental package from the UI.
  await page.getByTestId(`supp-pkg-summary-${id}`).fill('东侧绕行路线重新开放');
  await page.getByTestId(`create-supp-pkg-${id}`).click();

  // Side-by-side layout appears: parent snapshot pane + diff pane.
  await expect(page.getByTestId(`parent-pane-${id}`)).toBeVisible();
  await expect(page.getByTestId(`diff-pane-${id}`)).toBeVisible();

  // Parent pane still shows the FROZEN value for a1 (进行中).
  await expect(page.getByTestId(`parent-action-${id}-${A1}`)).toContainText('进行中');

  // Diff pane shows the additions and the field-level change.
  await expect(page.getByTestId(`diff-added-timeline-${id}-${EV3}`)).toContainText('重新开放');
  await expect(page.getByTestId(`diff-added-action-${id}-${AI3}`)).toContainText('通行能力');
  await expect(page.getByTestId(`diff-change-${id}-${A1}-status`)).toContainText('in_progress');
  await expect(page.getByTestId(`diff-change-${id}-${A1}-status`)).toContainText('done');
});

test('two sessions creating a supplemental package converge to a single package', async ({
  browser,
  request,
}) => {
  // Session 1 creates + signs, then adds a post-sign-off action item.
  const ctx1 = await browser.newContext();
  const page1 = await ctx1.newPage();
  await page1.goto('/');
  const id = await createAndSignHandoff(page1);

  await request.post('/api/incidents/inc-gd-20260729-01/action-items', {
    data: {
      id: AI3,
      title: '后续复核项',
      responsible_party: '晚班',
      occurred_at: '2026-07-29T06:05:00.000Z',
      actor: '晚班',
    },
  });

  // Session 2 opens the same incident and sees the signed handoff.
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto('/');
  await expect(page2.getByTestId(`handoff-status-${id}`)).toHaveText('已签收', { timeout: 8000 });

  // Both sessions create a supplemental package near-simultaneously.
  await Promise.all([
    page1.getByTestId(`create-supp-pkg-${id}`).click(),
    page2.getByTestId(`create-supp-pkg-${id}`).click(),
  ]);

  // Both converge to a package view.
  await expect(page1.getByTestId(`supp-pkg-${id}`)).toBeVisible({ timeout: 8000 });
  await expect(page2.getByTestId(`supp-pkg-${id}`)).toBeVisible({ timeout: 8000 });

  // Exactly one package exists on the server.
  const detail = await request.get(`/api/handoffs/${id}`);
  const body = await detail.json();
  expect(body.supplemental_handoff).toBeTruthy();
  expect(body.supplemental_handoff.parent_handoff_id).toBe(id);

  await ctx1.close();
  await ctx2.close();
});
