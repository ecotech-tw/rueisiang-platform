// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { TableBulkActionMenu, type TableBulkActionOption } from "@rueisiang/ui";
import { TableMobileSelectAll } from "./TableBulkActionControls.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actions: TableBulkActionOption[] = [
  { id: "approve", label: "確定發放", eligibleCount: 2 },
  { id: "withdraw", label: "撤回已發放", eligibleCount: 0 },
];

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

it("點擊表頭批次操作按鈕後才顯示操作選單，選取後回報操作 id", () => {
  function Harness() {
    const [actionId, setActionId] = useState<string | null>(null);
    return createElement("div", null,
      createElement(TableBulkActionMenu, { actionId, actions, onChange: setActionId }),
      createElement("output", null, actionId ?? "none"),
    );
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(Harness)));

  expect(document.querySelector('[role="menuitem"]')).toBeNull();
  const trigger = container.querySelector("button");
  expect(trigger?.textContent).toBe("批次操作");
  expect(trigger?.querySelector("svg")).not.toBeNull();
  expect(trigger?.className).toContain("border-line");
  act(() => trigger?.click());

  const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]');
  expect(items.length).toBe(2);
  expect(items.item(1).getAttribute("aria-disabled")).toBe("true");
  act(() => items.item(0).click());
  expect(container.querySelector("output")?.textContent).toBe("approve");
  expect(container.querySelector("button")?.textContent).toBe("取消批次操作");
  expect(container.querySelector("button")?.className).toContain("bg-brand-soft");
  act(() => container?.querySelector("button")?.click());
  expect(container.querySelector("output")?.textContent).toBe("none");
});

it("只有一種操作時點擊批次操作即可開始，啟用後按鈕變成結束操作", () => {
  const singleAction: TableBulkActionOption[] = [{ id: "cancel", label: "取消申請", eligibleCount: 1 }];
  function Harness() {
    const [actionId, setActionId] = useState<string | null>(null);
    return createElement("div", null,
      createElement(TableBulkActionMenu, { actionId, actions: singleAction, onChange: setActionId }),
      createElement("output", null, actionId ?? "none"),
    );
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(Harness)));
  expect(document.querySelector('[role="menuitem"]')).toBeNull();

  act(() => container?.querySelector("button")?.click());
  expect(container.querySelector("output")?.textContent).toBe("cancel");
  expect(container.querySelector("button")?.textContent).toBe("取消批次操作");
  expect(container.querySelector("button")?.className).toContain("bg-brand-soft");
});

it("手機全選列的部分選取跟著 indeterminate prop 走，全選或清空時拿掉", () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (checked: boolean, indeterminate: boolean) => act(() => root?.render(createElement(TableMobileSelectAll, { variant: "plain", checked, indeterminate, "aria-label": "全選本頁", onChange: () => {}, children: "全選本頁" })));

  render(false, false);
  const input = container.querySelector<HTMLInputElement>("input[type=checkbox]");
  expect(input?.indeterminate).toBe(false);
  render(false, true);
  expect(input?.indeterminate).toBe(true);
  render(true, false);
  expect(input?.indeterminate).toBe(false);
  expect(input?.checked).toBe(true);
});
