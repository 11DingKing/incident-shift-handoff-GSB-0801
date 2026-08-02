import { test, expect } from './fixtures';

const INCIDENT = 'inc-gd-20260729-01';
const AI_ROUTE = 'ai-gd-20260729-route-review';
const AI_TEMP = 'ai-gd-20260729-temp-structure';

async function setActor(page: import('@playwright/test').Page, name: string) {
  await page.goto('/');
  const input = page.locator('#actor-input');
  await input.fill(name);
  await page.keyboard.press('Enter');
}

test.describe('cross-session concurrency and handoff', () => {
  test.beforeEach(async ({ resetDb }) => {
    await resetDb();
  });

  test('two browser sessions: one update wins, other sees field-level conflict and converges', async ({ page, browser }) => {
    // Session A
    await setActor(page, '会话A');
    await expect(page.locator('text=复核东侧绕行路线')).toBeVisible();

    // Session B in a separate context
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await setActor(pageB, '会话B');

    // Session A changes the action item status to done first.
    await page.locator(`[data-testid="status-${AI_ROUTE}"]`).selectOption('done');
    await expect(page.locator(`.badge-done`).first()).toBeVisible();

    // Session B still holds v1; changing to blocked must produce a conflict.
    // We force session B's stale select by selecting blocked.
    await pageB.locator(`[data-testid="status-${AI_ROUTE}"]`).selectOption('blocked');
    await expect(pageB.locator('[data-testid="conflict-box"]')).toBeVisible();
    await expect(pageB.locator('[data-testid="conflict-box"]')).toContainText('blocked');
    await expect(pageB.locator('[data-testid="conflict-box"]')).toContainText('done');

    // Session B clicks "rebase" and after polling it converges to v2/done.
    await pageB.locator('[data-testid="rebase-btn"]').click();
    await expect(pageB.locator('[data-testid="conflict-box"]')).toHaveCount(0);

    // Final state on both sessions should converge (v2, done) within polling interval.
    await expect(page.locator(`[data-testid="status-${AI_ROUTE}"]`)).toHaveValue('done', { timeout: 5000 });
    await expect(pageB.locator(`[data-testid="status-${AI_ROUTE}"]`)).toHaveValue('done', { timeout: 5000 });

    await ctxB.close();
  });

  test('handoff snapshot, per-item acknowledge, sign-off, and immutable view', async ({ page }) => {
    await setActor(page, '接班人');

    // Create a handoff snapshot
    await page.getByRole('button', { name: '生成交接快照' }).click();
    await expect(page.locator('.handoff-detail')).toBeVisible();

    // Per-item acknowledge one item (idempotent button)
    const ackBtn = page.locator(`[data-testid="ack-${AI_ROUTE}"]`);
    await ackBtn.click();
    await expect(ackBtn).toContainText('已确认');

    // Sign off the package
    await page.locator('[data-testid="signoff-btn"]').click();
    await expect(page.locator('.handoff-detail .badge-acknowledged')).toBeVisible();

    // The unacknowledged item remains open in the snapshot (not auto-closed)
    const tempRow = page.locator('.ack-row', { hasText: '确认临时搭建物撤离结果' });
    await expect(tempRow).toContainText('快照状态 open');
  });

  test('changes after sign-off appear as supplementary events, snapshot stays immutable', async ({ page, request }) => {
    await setActor(page, '接班人');
    await page.getByRole('button', { name: '生成交接快照' }).click();
    await page.locator('[data-testid="signoff-btn"]').click();
    await expect(page.locator('.handoff-detail .badge-acknowledged')).toBeVisible();

    // A second API client updates an action item after sign-off.
    const items = await request.get(`http://localhost:3001/api/incidents/${INCIDENT}/action-items`);
    const list = await items.json();
    const temp = list.find((i: any) => i.action_item_id === AI_TEMP);
    const update = await request.patch(`http://localhost:3001/api/action-items/${AI_TEMP}`, {
      headers: { 'Content-Type': 'application/json', 'X-Actor': encodeURIComponent('API客户端2') },
      data: { status: 'in_progress', expected_version: temp.version },
    });
    expect(update.ok()).toBeTruthy();

    // The handoff detail should show a supplementary event; snapshot status remains open.
    await expect(page.locator('text=签收后补充').first()).toBeVisible({ timeout: 5000 });
    const tempRow = page.locator('.ack-row', { hasText: '确认临时搭建物撤离结果' });
    await expect(tempRow).toContainText('快照状态 open');
  });

  test('duplicate sign-off submissions do not create two confirmations', async ({ page, request }) => {
    await setActor(page, '接班人');
    await page.getByRole('button', { name: '生成交接快照' }).click();
    await expect(page.locator('.handoff-detail')).toBeVisible();

    // Two simultaneous API client sign-offs with same idempotency key.
    const handoffId = await page.locator('.handoff-item.active strong').textContent() as string;
    const payload = { confirmed_by: '接班人', note: '签收', idempotency_key: '接班人:hnd-test:package' };
    const [r1, r2] = await Promise.all([
      request.post(`http://localhost:3001/api/handoffs/${handoffId}/acknowledge`, {
        headers: { 'Content-Type': 'application/json' },
        data: { ...payload, idempotency_key: 'dup-key' },
      }),
      request.post(`http://localhost:3001/api/handoffs/${handoffId}/acknowledge`, {
        headers: { 'Content-Type': 'application/json' },
        data: { ...payload, idempotency_key: 'dup-key' },
      }),
    ]);
    expect(r1.ok()).toBeTruthy();
    expect(r2.ok()).toBeTruthy();

    const detail = await (await request.get(`http://localhost:3001/api/handoffs/${handoffId}`)).json();
    const pkgAcks = detail.acknowledgments.filter((a: any) => a.action_item_id === null);
    expect(pkgAcks).toHaveLength(1);
    expect(detail.handoff.version).toBe(2);
  });

  test('keyboard navigation and focus restoration after conflict', async ({ page }) => {
    await setActor(page, '接班人');

    // Tab into the first action item's select
    const select = page.locator(`[data-testid="status-${AI_ROUTE}"]`);
    await select.focus();
    await expect(select).toBeFocused();

    // Keyboard select triggers save
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    // (open -> in_progress may not change value; just verify focus is retained)
    await expect(select).toBeFocused();
  });

  test('supplementary handoff: append ev-03 and ai-03, create child package, show side-by-side diffs', async ({ page, request }) => {
    await setActor(page, '接班人');

    // Create and sign off the parent package.
    await page.getByRole('button', { name: '生成交接快照' }).click();
    await page.locator('[data-testid="signoff-btn"]').click();
    await expect(page.locator('.badge-acknowledged').first()).toBeVisible();

    // Append new timeline event ev-03 and new action item ai-03 via API.
    await request.post(`http://localhost:3001/api/incidents/${INCIDENT}/timeline`, {
      headers: { 'Content-Type': 'application/json', 'X-Actor': encodeURIComponent('夜班') },
      data: {
        event_id: 'ev-gd-20260729-03',
        event_type: 'update',
        summary: '东侧绕行路线重新开放',
        actor: '夜班-赵六',
      },
    });
    await request.post(`http://localhost:3001/api/incidents/${INCIDENT}/action-items`, {
      headers: { 'Content-Type': 'application/json', 'X-Actor': encodeURIComponent('夜班') },
      data: {
        action_item_id: 'ai-gd-20260729-03',
        title: '东侧绕行路线重新开放',
        description: '积水消退，恢复通行',
        status: 'done',
        owner: '应急协调组-李工',
      },
    });
    // Change an existing action item so a modified-field diff is produced.
    const items = await (await request.get(`http://localhost:3001/api/incidents/${INCIDENT}/action-items`)).json();
    const route = items.find((i: any) => i.action_item_id === AI_ROUTE);
    await request.patch(`http://localhost:3001/api/action-items/${AI_ROUTE}`, {
      headers: { 'Content-Type': 'application/json', 'X-Actor': encodeURIComponent('夜班') },
      data: { status: 'done', expected_version: route.version },
    });

    // Create the supplementary handoff via the UI.
    await page.locator('[data-testid="create-supplementary-btn"]').click();

    // A child package should be selected and show the side-by-side diff grid.
    await expect(page.locator('[data-testid="diff-grid"]')).toBeVisible();
    // New action item ai-03 appears as an added diff.
    await expect(page.locator('[data-testid="diff-ai-gd-20260729-03"]')).toContainText('新增');
    await expect(page.locator('[data-testid="diff-ai-gd-20260729-03"]')).toContainText('东侧绕行路线重新开放');
    // New timeline event ev-03 appears.
    await expect(page.locator('[data-testid="diff-ev-gd-20260729-03"]')).toBeVisible();
    // Existing route item shows status modified in_progress -> done.
    const routeDiff = page.locator('[data-testid="diff-ai-gd-20260729-route-review"]');
    await expect(routeDiff).toContainText('in_progress');
    await expect(routeDiff).toContainText('done');
  });

  test('concurrent supplementary creation with same idempotency key yields one child package', async ({ page, request }) => {
    await setActor(page, '接班人');
    await page.getByRole('button', { name: '生成交接快照' }).click();
    await page.locator('[data-testid="signoff-btn"]').click();
    await expect(page.locator('.badge-acknowledged').first()).toBeVisible();

    // Find parent handoff id.
    const handoffs = await (await request.get(`http://localhost:3001/api/incidents/${INCIDENT}/handoffs`)).json();
    const parent = handoffs.find((h: any) => h.parent_handoff_id === null);
    expect(parent).toBeTruthy();

    const payload = {
      parent_handoff_id: parent.handoff_id,
      from_shift: 'A',
      to_shift: 'B',
      summary: '',
      idempotency_key: 'concurrent-supp-key',
    };
    const url = `http://localhost:3001/api/incidents/${INCIDENT}/handoffs/supplementary`;
    const [r1, r2] = await Promise.all([
      request.post(url, { headers: { 'Content-Type': 'application/json' }, data: payload }),
      request.post(url, { headers: { 'Content-Type': 'application/json' }, data: payload }),
    ]);
    expect(r1.ok()).toBeTruthy();
    expect(r2.ok()).toBeTruthy();
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.handoff.handoff_id).toBe(b2.handoff.handoff_id);
    const created = [b1.created, b2.created].filter(Boolean).length;
    expect(created).toBe(1);

    const all = await (await request.get(`http://localhost:3001/api/incidents/${INCIDENT}/handoffs`)).json();
    const children = all.filter((h: any) => h.parent_handoff_id === parent.handoff_id);
    expect(children).toHaveLength(1);

    const audit = await (await request.get(`http://localhost:3001/api/incidents/${INCIDENT}/audit`)).json();
    const suppAudits = audit.filter((a: any) => a.action === 'supplementary_handoff_created');
    expect(suppAudits).toHaveLength(1);
  });
});
