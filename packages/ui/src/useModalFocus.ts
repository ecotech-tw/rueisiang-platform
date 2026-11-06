import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = "button, a[href], input, select, textarea, [tabindex]";

/**
 * 完整 modal 的鍵盤行為：打開時焦點移進去、Tab 在裡面繞圈、Escape 關閉、
 * 關掉之後焦點回到打開它的那個元素。Dialog（manageFocus）與倉位抽屜共用。
 *
 * **只有最上層的 modal 會處理。** 畫面上同時疊著兩層時（倉位抽屜上又開了「修改區塊」
 * 對話框），下面那層不搶焦點、不吃 Escape——否則 Tab 會被拉回底層、上層永遠到不了，
 * Escape 也會關錯一層。「最上層」是 DOM 裡最後一個 aria-modal="true"：對話框用
 * portal 掛在 body 尾端，後開的一定排在後面。
 */
export function useModalFocus(
  ref: RefObject<HTMLElement | null>,
  { enabled = true, onEscape }: { enabled?: boolean; onEscape: () => void },
) {
  // 要在 render 當下就記住：等到 effect 跑的時候，焦點可能已經被 autoFocus 拉進來了。
  const returnFocusRef = useRef(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!enabled) return;
    const container = ref.current;
    if (!container) return;
    const previous = returnFocusRef.current;
    const focusable = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0);
    const isTopmost = () => {
      const modals = document.querySelectorAll('[aria-modal="true"]');
      return modals[modals.length - 1] === container;
    };
    if (!container.contains(document.activeElement)) (focusable()[0] ?? container).focus({ preventScroll: true });

    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || !isTopmost()) return;
      if (event.key === "Escape") { event.preventDefault(); onEscapeRef.current(); return; }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) { event.preventDefault(); container?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === container || !container?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !container?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [enabled, ref]);
}
