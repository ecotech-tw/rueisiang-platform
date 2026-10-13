// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, it } from "vitest";
import { HrForms } from "./Forms.js";

it.each([
  ["/forms", "返回工作", "工作分類"],
  ["/forms?tab=leave", "新增申請", "請假表單"],
  ["/forms?tab=overtime", "新增申請", "加班表單"],
  ["/forms?tab=clock_correction", "新增申請", "補打卡表單"],
])("表單列表 %s 的 %s 導向 %s", async (path, label, expected) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const endpoint of ["/me/form-requests", "/me/overtime", "/me/leave-requests"]) {
    client.setQueryData(["hr", endpoint], { requests: [], reviewRequests: [] });
  }
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes>
      <Route path="/forms" element={<HrForms />} />
      <Route path="/work" element={<p>工作分類</p>} />
      <Route path="/forms/leave" element={<p>請假表單</p>} />
      <Route path="/forms/overtime" element={<p>加班表單</p>} />
      <Route path="/forms/new" element={<p>補打卡表單</p>} />
    </Routes></MemoryRouter></QueryClientProvider>));
    expect(container.querySelector('[aria-label="返回導覽"]')!.classList.contains("h-12")).toBe(true);
    expect(container.querySelector(".hr-form-sticky-controls")!.classList.contains("top-12")).toBe(true);
    expect(container.querySelector(".hr-form-add-inline .hr-form-add-button-inline")).not.toBeNull();
    expect(document.body.querySelector(".hr-form-add-portal .hr-form-add-button-floating")).not.toBeNull();
    expect(document.body.querySelector(".hr-form-add-portal")!.parentElement).toBe(document.body);
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label)!;
    expect(button).toBeDefined();
    await act(async () => button.click());
    expect(container.textContent).toBe(expected);
  } finally {
    await act(async () => root.unmount()); client.clear(); container.remove();
  }
});
