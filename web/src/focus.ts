import { useEffect, useLayoutEffect, useRef } from 'react';

const STORAGE_KEY = 'handoff:last-focus';

function focusIdOf(target: EventTarget | null): string | null {
  const el = target as HTMLElement | null;
  return el?.closest?.('[data-focus-id]')?.getAttribute('data-focus-id') ?? null;
}

/**
 * 焦点恢复：轮询/冲突刷新导致 DOM 重渲染、甚至整页刷新后，把焦点还给之前聚焦的控件。
 * 通过 focusin + click/input/change/keydown 捕获阶段持续记录最近交互的 data-focus-id
 * 并写入 sessionStorage（部分自动化/无窗口焦点环境不派发 focusin/pointerdown/keydown，
 * 但 click 与 input/change 始终可达）；焦点丢失或整页刷新后恢复。
 */
export function useFocusRestore(deps: unknown[]): void {
  const saved = useRef<string | null>(null);

  useEffect(() => {
    saved.current = sessionStorage.getItem(STORAGE_KEY);
    const record = (e: Event) => {
      const id = focusIdOf(e.target);
      if (id) {
        saved.current = id;
        sessionStorage.setItem(STORAGE_KEY, id);
      }
    };
    document.addEventListener('focusin', record);
    for (const type of ['click', 'input', 'change', 'keydown', 'pointerdown']) {
      document.addEventListener(type, record, true);
    }
    return () => {
      document.removeEventListener('focusin', record);
      for (const type of ['click', 'input', 'change', 'keydown', 'pointerdown']) {
        document.removeEventListener(type, record, true);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const id = saved.current;
    if (!id) return;
    const current = document.activeElement as HTMLElement | null;
    // 焦点仍在某个可聚焦控件上时不干预；仅当焦点丢失（回落到 body）时恢复
    if (current && current !== document.body && current.dataset?.focusId) return;
    document.querySelector<HTMLElement>(`[data-focus-id="${id}"]`)?.focus();
  }, deps);
}
