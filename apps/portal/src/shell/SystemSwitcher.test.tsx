// @vitest-environment jsdom
import type { Permission } from "@rueisiang/auth/permissions";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { SystemSwitcher } from "./SystemSwitcher.js";
import { UnsavedChangesProvider } from "./UnsavedChanges.js";

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function renderSwitcher(permissions: Permission[]) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter><UnsavedChangesProvider>
    <SystemSwitcher permissions={new Set(permissions)} collapsed={false} onNavigate={() => {}} />
  </UnsavedChangesProvider></MemoryRouter>));
  return [...host.querySelectorAll("a")].map((link) => link.getAttribute("href"));
}

describe("平台左下角的系統入口", () => {
  it("沒有任何系統權限時不顯示", async () => {
    expect(await renderSwitcher(["crm:customer:read"])).toEqual([]);
  });

  it("只有 HR 權限時只看得到 HRIS，只有會計權限時只看得到會計", async () => {
    expect(await renderSwitcher(["hr:schedule:read"])).toEqual(["/hr"]);
    await act(async () => root?.unmount());
    expect(await renderSwitcher(["accounting:expense:read"])).toEqual(["/accounting"]);
  });

  it("兩種權限都有時兩張卡都在，HRIS 在前", async () => {
    expect(await renderSwitcher(["hr:employee:read", "accounting:category:write"])).toEqual(["/hr", "/accounting"]);
  });
});
