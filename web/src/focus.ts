import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * 焦点恢复：轮询/冲突刷新导致 DOM 重渲染后，把焦点还给之前聚焦的控件。
 * 通过 focusin 监听持续记录最近聚焦的 data-focus-id（控件被禁用瞬间焦点会先掉到 body，
 * 渲染期再读 activeElement 已经太晚），提交后若焦点丢失则恢复。
 */
export function useFocusRestore(deps: unknown[]): void {
  const saved = useRef<string | null>(null);

  useEffect(() => {
    const onFocusIn = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t?.dataset?.focusId) saved.current = t.dataset.focusId;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  useLayoutEffect(() => {
    const id = saved.current;
    if (!id) return;
    const current = document.activeElement as HTMLElement | null;
    // 焦点仍在某个可聚焦控件上时不干预；仅当焦点丢失（回落到 body）时恢复
    if (current && current !== document.body && current.dataset?.focusId) return;
    const el = document.querySelector<HTMLElement>(`[data-focus-id="${id}"]`);
    el?.focus();
  }, deps);
}
