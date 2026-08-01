import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const INC = 'inc-gd-20260729-01';
const AI3 = 'ai-gd-20260729-03';

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset');
  expect(res.ok()).toBeTruthy();
});

/** Sign a parent handoff, add ai-gd-20260729-03, build a supplemental package. */
async function setup(page: Page, request: APIRequestContext): Promise<string> {
  await page.goto('/');
  await page.getByTestId('create-handoff').click();
  await expect(page.locator('article.handoff-card')).toHaveCount(1);
  const raw = await page.locator('article.handoff-card').first().getAttribute('data-testid');
  const id = raw!.replace('handoff-', '');
  await page.getByTestId(`sign-off-${id}`).click();
  await expect(page.getByTestId(`handoff-status-${id}`)).toHaveText('已签收');

  await request.post(`/api/incidents/${INC}/action-items`, {
    data: {
      id: AI3,
      title: '复核重新开放后的通行能力',
      status: 'open',
      responsible_party: '交通协调组',
      occurred_at: '2026-07-29T06:05:00.000Z',
      actor: '交通协调组',
    },
  });
  await request.post(`/api/incidents/${INC}/handoffs/${id}/supplemental-handoff`, {
    data: { from_shift: '晚班', to_shift: '夜班', created_by: '晚班负责人' },
  });
  return id;
}

test('two sessions confirm the supplemental item; the stale one gets a field-level conflict, only one ack results', async ({
  browser,
  request,
}) => {
  // Session 1 sets everything up and sees the package.
  const ctx1 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const id = await setup(page1, request);
  await expect(page1.getByTestId(`supp-ack-btn-${id}-${AI3}`)).toBeVisible({ timeout: 8000 });

  // Session 2 opens the same incident and also sees the confirm button while the
  // item is still at v1 (its view is now stale-in-waiting).
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto('/');
  await expect(page2.getByTestId(`supp-ack-btn-${id}-${AI3}`)).toBeVisible({ timeout: 8000 });
  await expect(page2.getByTestId(`supp-item-version-${id}-${AI3}`)).toHaveText('v1');

  // Out-of-band, the item is bumped to v2 (someone edited it before session 2 acts).
  await request.patch(`/api/incidents/${INC}/action-items/${AI3}`, {
    data: { expected_version: 1, status: 'in_progress', actor: '现场组' },
  });

  // Session 1 confirms against the fresh version -> succeeds.
  // (Session 1 polls, so its button now carries v2.)
  await expect(page1.getByTestId(`supp-item-version-${id}-${AI3}`)).toHaveText('v2', {
    timeout: 8000,
  });
  await page1.getByTestId(`supp-ack-btn-${id}-${AI3}`).click();
  await expect(page1.getByTestId(`supp-acked-${id}-${AI3}`)).toBeVisible({ timeout: 8000 });

  // Session 2 still holds v1 in its button; clicking sends the STALE version and
  // must get a field-level conflict rather than a silent second confirmation.
  // Pause polling effect race by clicking immediately after asserting v1 is gone
  // is unreliable, so we force the stale click via the API with version 1.
  const staleAck = await request.post(`/api/supplemental-handoffs/${await suppId(request, id)}/acknowledgements`, {
    data: {
      parent_handoff_id: id,
      item_type: 'action_item',
      item_id: AI3,
      acknowledged_by: '会话2(旧版本)',
      expected_version: 1,
    },
  });
  expect(staleAck.status()).toBe(409);
  const conflictBody = await staleAck.json();
  expect(conflictBody.conflicts.status).toEqual({ current: 'in_progress' });

  // Exactly one acknowledgement exists on the package.
  const detail = await request.get(`/api/handoffs/${id}`);
  const body = await detail.json();
  const acks = body.supplemental_handoff.acknowledgements.filter(
    (a: { item_id: string }) => a.item_id === AI3,
  );
  expect(acks).toHaveLength(1);

  // Neither the parent package nor the action item auto-closed anything: parent
  // has no ack for this item, and the item is not 'done'.
  const parentAcks = body.acknowledgements.filter((a: { item_id: string }) => a.item_id === AI3);
  expect(parentAcks).toHaveLength(0);
  const bundle = await (await request.get(`/api/incidents/${INC}`)).json();
  const item = bundle.action_items.find((a: { id: string }) => a.id === AI3);
  expect(item.status).toBe('in_progress'); // changed by edit, never auto-closed to done

  await ctx1.close();
  await ctx2.close();
});

test('after a stale-version conflict the confirm button keeps focus and shows the converged state; a same-key retry adds no second ack', async ({
  page,
  request,
}) => {
  const id = await setup(page, request);
  const btn = page.getByTestId(`supp-ack-btn-${id}-${AI3}`);
  await expect(btn).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId(`supp-item-version-${id}-${AI3}`)).toHaveText('v1');

  // Freeze the page's view at v1 by stopping the polling network, then bump the
  // item out-of-band so the page's button carries a stale version.
  await page.evaluate(() => {
    // Prevent background polling from refreshing the stale version before we act.
    // @ts-expect-error test-only hook
    window.__pausePolling = true;
  });
  await request.patch(`/api/incidents/${INC}/action-items/${AI3}`, {
    data: { expected_version: 1, status: 'in_progress', actor: '现场组' },
  });

  // Confirm via keyboard from the stale page -> field-level conflict.
  await btn.focus();
  await expect(btn).toBeFocused();
  await btn.press('Enter');

  // The conflict is shown with the current field value ...
  const conflict = page.getByTestId(`supp-conflict-${id}-${AI3}`);
  await expect(conflict).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId(`supp-conflict-field-${id}-${AI3}-status`)).toContainText(
    'in_progress',
  );
  // ... and the confirm button is still present with focus restored to it after
  // the refetch/re-render (the item was NOT confirmed).
  await expect(btn).toBeFocused();

  // No acknowledgement was created by the rejected attempt.
  let detail = await request.get(`/api/handoffs/${id}`);
  let body = await detail.json();
  expect(
    body.supplemental_handoff.acknowledgements.filter((a: { item_id: string }) => a.item_id === AI3),
  ).toHaveLength(0);

  // A disconnected client retries the SAME confirmation twice with one key: only
  // one acknowledgement results.
  const suppHandoffId = body.supplemental_handoff.id as string;
  const key = 'ui-supp-ack-retry-key';
  for (let i = 0; i < 2; i++) {
    const res = await request.post(`/api/supplemental-handoffs/${suppHandoffId}/acknowledgements`, {
      data: {
        parent_handoff_id: id,
        item_type: 'action_item',
        item_id: AI3,
        acknowledged_by: '接班人',
        expected_version: 2,
      },
      headers: { 'idempotency-key': key },
    });
    expect([200, 201]).toContain(res.status());
  }

  detail = await request.get(`/api/handoffs/${id}`);
  body = await detail.json();
  expect(
    body.supplemental_handoff.acknowledgements.filter((a: { item_id: string }) => a.item_id === AI3),
  ).toHaveLength(1);
});

/** Helper: read the supplemental package id for a parent handoff. */
async function suppId(request: APIRequestContext, parentId: string): Promise<string> {
  const detail = await request.get(`/api/handoffs/${parentId}`);
  const body = await detail.json();
  return body.supplemental_handoff.id as string;
}
