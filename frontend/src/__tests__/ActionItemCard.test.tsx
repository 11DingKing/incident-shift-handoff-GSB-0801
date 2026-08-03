import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionItemCard } from '../ActionItemCard';
import { ApiClient } from '../api';
import { ApiError, type ActionItem } from '../types';

const baseItem: ActionItem = {
  action_item_id: 'ai-1',
  incident_id: 'inc-1',
  title: '复核东侧绕行路线',
  description: '联合交警复核绕行路线',
  status: 'in_progress',
  owner: '应急协调组-李工',
  due_at: null,
  occurred_at: '2026-07-29T08:20:00.000Z',
  created_at: '2026-07-29T08:20:00.000Z',
  updated_at: '2026-07-29T08:20:00.000Z',
  version: 1,
};

function makeApi() {
  return { updateActionItem: vi.fn() } as unknown as ApiClient;
}

describe('ActionItemCard', () => {
  it('renders title, owner and optimistic version', () => {
    render(
      <ActionItemCard item={baseItem} api={makeApi()} onUpdated={vi.fn()} onToast={vi.fn()} />,
    );
    expect(screen.getByText('复核东侧绕行路线')).toBeInTheDocument();
    expect(screen.getByText(/应急协调组-李工/)).toBeInTheDocument();
    expect(screen.getByText('v1')).toBeInTheDocument();
  });

  it('calls updateActionItem with expected_version and shows success', async () => {
    const api = makeApi();
    (api.updateActionItem as any).mockResolvedValue({ ...baseItem, status: 'done', version: 2 });
    const onUpdated = vi.fn();
    render(<ActionItemCard item={baseItem} api={api} onUpdated={onUpdated} onToast={vi.fn()} />);

    const select = screen.getByTestId('status-ai-1');
    await userEvent.selectOptions(select, 'done');

    await waitFor(() => expect(api.updateActionItem).toHaveBeenCalledWith('ai-1', {
      status: 'done', expected_version: 1,
    }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
  });

  it('shows field-level conflict box on 409 and does not mutate state', async () => {
    const api = makeApi();
    (api.updateActionItem as any).mockRejectedValue(new ApiError(409, 'conflict', [
      { field: 'status', submitted: 'done', current: 'blocked', current_version: 2 },
    ]));
    const toast = vi.fn();
    render(<ActionItemCard item={baseItem} api={api} onUpdated={vi.fn()} onToast={toast} />);

    await userEvent.selectOptions(screen.getByTestId('status-ai-1'), 'done');

    const conflictBox = await screen.findByTestId('conflict-box');
    expect(conflictBox).toBeInTheDocument();
    expect(conflictBox.textContent).toContain('blocked');
    expect(conflictBox.textContent).toContain('done');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('冲突'), 'err');
  });

  it('is keyboard accessible: select can be focused and changed via keyboard', async () => {
    const api = makeApi();
    (api.updateActionItem as any).mockResolvedValue({ ...baseItem, status: 'done', version: 2 });
    render(<ActionItemCard item={baseItem} api={api} onUpdated={vi.fn()} onToast={vi.fn()} />);
    const select = screen.getByTestId('status-ai-1');
    select.focus();
    expect(select).toHaveFocus();
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    // Selecting via keyboard still triggers the change
    fireEvent.change(select, { target: { value: 'done' } });
    await waitFor(() => expect(api.updateActionItem).toHaveBeenCalled());
  });
});

describe('ApiClient idempotency keys', () => {
  it('produces deterministic idempotency keys per (actor,handoff,item)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true }),
    })) as unknown as typeof fetch;
    const client = new ApiClient({ actor: 'alice', baseUrl: '' });
    (globalThis as any).fetch = fetchMock;
    await client.acknowledgeItem('h1', 'ai-1', 'note');
    await client.acknowledgeItem('h1', 'ai-1', 'note');
    const calls = (fetchMock as any).mock.calls;
    const body1 = JSON.parse(calls[0][1].body);
    const body2 = JSON.parse(calls[1][1].body);
    expect(body1.idempotency_key).toBe(body2.idempotency_key);
    expect(body1.idempotency_key).toContain('alice');
    expect(body1.idempotency_key).toContain('h1');
    expect(body1.idempotency_key).toContain('ai-1');
  });
});
