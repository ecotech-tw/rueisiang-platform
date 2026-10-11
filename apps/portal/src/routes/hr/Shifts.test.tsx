// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { HrShifts } from "./Shifts.js";
import type { HrShiftsResponse } from "./api.js";

const showToast = vi.fn();
vi.mock("../../auth/session.js", () => ({ useSession: () => ({ permissions: new Set(["hr:schedule:read", "hr:schedule:write"]) }) }));
vi.mock("../../shell/Toast.js", () => ({ useToast: () => ({ show: showToast }) }));

const initialShifts: HrShiftsResponse = {
  scopes: [{ id: "store", name: "門市" }],
  shifts: [
    { versionId: "v1", templateId: "t1", scopeId: "store", name: "早班", dayType: "weekday", revision: 1, startSecond: 32400, endSecond: 64800, endDayOffset: 0, standardMinutes: 480, breakMinutes: 60, requiredHeadcount: 1 },
    { versionId: "v2", templateId: "t2", scopeId: "store", name: "晚班", dayType: "weekday", revision: 1, startSecond: 36000, endSecond: 72000, endDayOffset: 0, standardMinutes: 480, breakMinutes: 60, requiredHeadcount: 1 },
  ],
};
const managerData = { scopes: [{ id: "store", name: "門市", userId: null, revision: 0 }], candidates: [] };

afterEach(() => { vi.unstubAllGlobals(); showToast.mockClear(); notifyManager.setScheduler((callback) => setTimeout(callback, 0)); });

it("部分儲存後重新載入並關閉舊草稿，避免用過期 revision 重試", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  notifyManager.setScheduler(queueMicrotask);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  let shifts = initialShifts;
  let patchCount = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/shift-templates") && !init?.method) return Response.json(shifts);
    if (path.endsWith("/schedule-managers") && !init?.method) return Response.json(managerData);
    if (path.includes("/shift-templates/") && init?.method === "PATCH") {
      patchCount += 1;
      if (patchCount === 2) return Response.json({ error: "班別已被其他人修改，請重新整理。" }, { status: 409 });
      const templateId = path.split("/").at(-1);
      const values = JSON.parse(String(init.body)) as { name: string };
      shifts = { ...shifts, shifts: shifts.shifts.map((shift) => shift.templateId === templateId ? { ...shift, name: values.name, revision: shift.revision + 1 } : shift) };
      return Response.json({ id: templateId, revision: 2 });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });

  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><HrShifts /></QueryClientProvider></MemoryRouter>));
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="編輯 門市 的班別與排班負責人"]')!.click(); });
    const changeName = async (label: string, value: string) => act(async () => {
      const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await changeName("早班名稱", "早班改名");
    await changeName("晚班名稱", "晚班改名");
    await act(async () => { [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "儲存")!.click(); });
    // 等對話框真的從畫面上消失，不賭一個固定的毫秒數：兩次 PATCH、重新載入與收合都要時間，
    // CI 的機器慢一點，固定等 260ms 就會早一步檢查而失敗。每一小段各包一個 act——
    // React 的更新要等 act 結束才會套到畫面上，整段等在同一個 act 裡永遠看不到它關掉。
    const deadline = Date.now() + 3_000;
    while (document.body.querySelector('[role="dialog"]') && Date.now() < deadline) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }

    expect(patchCount).toBe(2);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("早班改名");
    expect(container.textContent).toContain("晚班");
    expect(container.textContent).not.toContain("晚班改名");
    expect(showToast).toHaveBeenCalledWith("部分設定已儲存。請重新開啟編輯視窗確認，再完成其他變更。", "danger");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});
