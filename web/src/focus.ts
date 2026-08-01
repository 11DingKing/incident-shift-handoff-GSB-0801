import { useLayoutEffect, useRef } from 'react';

/**
 * 焦点恢复：轮询刷新导致 DOM 重渲染后，把焦点还给之前聚焦的同类控件。
 * 每个需要保持焦点的交互元素标注 data-focus-id。
 */
export function useFocusRestore(deps: unknown[]): void {
  const saved = useRef<string | null>(null);

  // 渲染前记录（在依赖变化触发的渲染提交后恢复）
  const active = document.activeElement as HTMLElement | null;
  if (active?.dataset?.focusId) {
    saved.current = active.dataset.focusId;
  }

  useLayoutEffect(() => {
    const id = saved.current;
    if (!id) return;
    const current = document.activeElement as HTMLElement | null;
    // 仅当焦点因重渲染丢失（回落到 body）时恢复
    if (current && current !== document.body) return;
    const el = document.querySelector<HTMLElement>(`[data-focus-id="${id}"]`);
    el?.focus();
  }, deps);
}
