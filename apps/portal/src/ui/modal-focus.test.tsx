// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModalFocus } from "@rueisiang/ui";

/*
 * useModalFocus 是倉位抽屜與 Dialog（manageFocus）共用的鍵盤行為。
 * 這裡守的是抽屜上疊對話框那種情況：只有最上層處理 Tab 與 Escape。
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
});
