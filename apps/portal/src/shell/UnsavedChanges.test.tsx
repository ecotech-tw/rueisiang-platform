// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { UnsavedChangesProvider, useConfirmLeave, useUnsavedChanges } from "./UnsavedChanges.js";

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function DirtyPage() {
  useUnsavedChanges(true, "已排入 3 天尚未儲存");
  const confirmLeave = useConfirmLeave();
  return <button type="button" onClick={() => void confirmLeave()}>離開</button>;
}

async function openDialogAt(path: string) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter initialEntries={[path]}><UnsavedChangesProvider><DirtyPage /></UnsavedChangesProvider></MemoryRouter>));
  // 掛上去之後才點：provider 換頁時會收掉還開著的視窗，那個 effect 在第一次掛載也會跑。
  await act(async () => host.querySelector("button")!.click());
  const leave = [...document.querySelectorAll("button")].find((button) => button.textContent === "離開並捨棄");
  expect(leave).toBeTruthy();
  return leave!.className;
}

describe("未儲存變更的確認視窗", () => {
  it("在 HRIS 頁面上跟其他 HRIS 按鈕一樣是玻璃皮膚", async () => {
    expect(await openDialogAt("/hr/scheduling")).toContain("backdrop-filter");
  });

  it("在其他頁面維持預設的實色皮膚", async () => {
    expect(await openDialogAt("/crm/customers")).not.toContain("backdrop-filter");
  });
});
