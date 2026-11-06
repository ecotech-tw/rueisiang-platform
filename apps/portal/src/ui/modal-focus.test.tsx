// @vitest-environment jsdom
import { act, StrictMode, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, Dialog, useModalFocus } from "@rueisiang/ui";

/*
 * useModalFocus 是倉位抽屜與 Dialog（manageFocus）共用的鍵盤行為。
 * 這裡守三件事：抽屜上疊對話框時只有最上層處理 Tab 與 Escape；
 * dev 的 StrictMode 假卸載不會把 autoFocus 放進欄位的焦點拉走；
 * 全站共用的 ConfirmDialog 走同一套（焦點在取消、處理中不能 Escape、疊層時只關自己）。
 */

function Layer({ name, onEscape }: { name: string; onEscape: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, { onEscape });
  return (
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={name}>
      <button type="button">{name}-first</button>
      <button type="button">{name}-last</button>
    </div>
  );
}

function Page({ drawer, dialog, onDrawerEscape, onDialogEscape }: { drawer: boolean; dialog: boolean; onDrawerEscape: () => void; onDialogEscape: () => void }) {
  return (
    <>
      <button type="button">opener</button>
      {drawer ? <Layer name="drawer" onEscape={onDrawerEscape} /> : null}
      {dialog ? <Layer name="dialog" onEscape={onDialogEscape} /> : null}
    </>
  );
}

let host: HTMLDivElement;
let root: Root;
const active = () => (document.activeElement as HTMLElement | null)?.textContent ?? "";
const press = (key: string, shiftKey = false) => act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom 不排版，getClientRects 永遠是空的；當成每個元素都看得到。
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function render(props: Parameters<typeof Page>[0]) {
  act(() => root.render(<Page {...props} />));
}

describe("useModalFocus", () => {
  it("打開時焦點移進去、Tab 在裡面繞圈、關掉後回到打開它的元素", () => {
    const noop = () => {};
    render({ drawer: false, dialog: false, onDrawerEscape: noop, onDialogEscape: noop });
    (host.querySelector("button") as HTMLButtonElement).focus();
    expect(active()).toBe("opener");

    render({ drawer: true, dialog: false, onDrawerEscape: noop, onDialogEscape: noop });
    expect(active()).toBe("drawer-first");

    (host.querySelector("[aria-label=drawer] button:last-child") as HTMLButtonElement).focus();
    press("Tab");
    expect(active()).toBe("drawer-first");
    press("Tab", true);
    expect(active()).toBe("drawer-last");

    render({ drawer: false, dialog: false, onDrawerEscape: noop, onDialogEscape: noop });
    expect(active()).toBe("opener");
  });

  it("疊了一層對話框時，只有上層處理 Tab 與 Escape", () => {
    const drawerEscape = vi.fn();
    const dialogEscape = vi.fn();
    render({ drawer: true, dialog: false, onDrawerEscape: drawerEscape, onDialogEscape: dialogEscape });
    render({ drawer: true, dialog: true, onDrawerEscape: drawerEscape, onDialogEscape: dialogEscape });
    expect(active()).toBe("dialog-first");

    (host.querySelector("[aria-label=dialog] button:last-child") as HTMLButtonElement).focus();
    press("Tab");
    // 底下的抽屜不能把焦點搶回去。
    expect(active()).toBe("dialog-first");

    press("Escape");
    expect(dialogEscape).toHaveBeenCalledTimes(1);
    expect(drawerEscape).not.toHaveBeenCalled();

    // 上層關掉後，焦點回到抽屜裡打開它的那顆，抽屜重新接手 Escape。
    render({ drawer: true, dialog: false, onDrawerEscape: drawerEscape, onDialogEscape: dialogEscape });
    expect(active()).toBe("drawer-first");
    press("Escape");
    expect(drawerEscape).toHaveBeenCalledTimes(1);
  });

  it("StrictMode 的假卸載不會把 autoFocus 的焦點拉走；真的關掉才還原", () => {
    function Form() {
      const ref = useRef<HTMLDivElement>(null);
      useModalFocus(ref, { onEscape: () => {} });
      return (
        <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true">
          <button type="button">close</button>
          <input aria-label="name" autoFocus />
        </div>
      );
    }
    const show = (open: boolean) => act(() => root.render(<StrictMode><button type="button">opener</button>{open ? <Form /> : null}</StrictMode>));
    show(false);
    (host.querySelector("button") as HTMLButtonElement).focus();
    show(true);
    expect((document.activeElement as HTMLElement | null)?.getAttribute("aria-label")).toBe("name");
    show(false);
    expect(active()).toBe("opener");
  });
});

describe("ConfirmDialog 的鍵盤行為", () => {
  // Dialog 退場動畫播完才呼叫 onClose；jsdom 沒有 matchMedia，所以走計時器那條。
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const finishExit = () => act(() => { vi.advanceTimersByTime(500); });

  it("焦點預設在取消、Tab 在兩顆按鈕間繞圈、處理中按 Escape 不會關、關掉後焦點還原", () => {
    const onCancel = vi.fn();
    const show = (open: boolean, pending = false) => act(() => root.render(
      <>
        <button type="button">opener</button>
        {open ? <ConfirmDialog title="刪除？" pending={pending} onConfirm={() => {}} onCancel={onCancel}><p>無法復原。</p></ConfirmDialog> : null}
      </>,
    ));
    show(false);
    (host.querySelector("button") as HTMLButtonElement).focus();
    show(true);
    expect(active()).toBe("取消");

    // jsdom 不會自己移動 Tab 焦點，這裡驗的是頭尾繞圈那一段（hook 負責的部分）。
    press("Tab", true);
    expect(active()).toBe("確定");
    press("Tab");
    expect(active()).toBe("取消");

    show(true, true);
    press("Escape");
    finishExit();
    expect(onCancel).not.toHaveBeenCalled();

    show(true, false);
    (document.querySelector("[role=alertdialog] button") as HTMLButtonElement).focus();
    press("Escape");
    finishExit();
    expect(onCancel).toHaveBeenCalledTimes(1);

    show(false);
    expect(active()).toBe("opener");
  });

  it("疊在另一個對話框上時，Escape 只關確認框", () => {
    const onClose = vi.fn();
    const onCancel = vi.fn();
    act(() => root.render(
      <>
        <Dialog manageFocus title="編輯" onClose={onClose}><button type="button">field</button></Dialog>
        <ConfirmDialog title="解除？" onConfirm={() => {}} onCancel={onCancel}><p>確定要解除？</p></ConfirmDialog>
      </>,
    ));
    expect(active()).toBe("取消");
    press("Escape");
    finishExit();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
