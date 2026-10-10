import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HrImpersonation, hrSandboxEmployeeLabel } from "./HrImpersonation.js";
import { Sandbox } from "./Sandbox.js";
import type { HrSandboxEmployee, SandboxConfig } from "./api.js";

const alice: HrSandboxEmployee = { userId: "alice", displayName: "<script>甲員工</script>", employeeNumber: "E001", userStatus: "active", lineBound: true };
const bob: HrSandboxEmployee = { userId: "bob", displayName: "乙員工", employeeNumber: "E002", userStatus: "disabled", lineBound: false };

function withClient(children: React.ReactNode, employees: HrSandboxEmployee[], config?: SandboxConfig) {
  const client = new QueryClient();
  client.setQueryData(["assistant", "sandbox", "hr-employees", "", 1], { employees, page: 1, hasMore: false });
  if (config) client.setQueryData(["assistant", "sandbox", "config"], config);
  const html = renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}>{children}</QueryClientProvider></MemoryRouter>);
  client.clear();
  return html;
}

function renderPicker(employee: HrSandboxEmployee | null, employees = [alice, bob], bindingConfigured = true) {
  return withClient(
    <HrImpersonation employee={employee} bindingConfigured={bindingConfigured} disabled={false} onChange={() => {}} />,
    employees,
  );
}

function tool(key: string, label: string): SandboxConfig["tools"][number] {
  return { key, label, description: "測試", surfaces: ["sandbox", "line"], requiredPermissions: [], status: "enabled" };
}

function sandboxConfig(available: boolean): SandboxConfig {
  const prompt = { id: "prompt", assistantKey: "test", revision: 1, systemPrompt: "測試", isActive: true, createdBy: "admin", createdAt: "2026-01-01" };
  return {
    assistantKey: "test", configured: true, providers: { codex: true, gemini: true }, defaultModel: "gemini", activeModel: "gemini",
    fallbackModel: null, activeModelUpdatedAt: null, credentialStatus: { codex: "ready", codexLastErrorAt: null },
    models: [{ id: "gemini", label: "Gemini 測試模型", category: "test", quota: { rpm: 1, tpm: 1, rpd: 1 }, provider: "google", supported: true, configured: true, supportsVision: true }],
    tools: [tool("crm_search_customers", "搜尋客戶"), ...(available ? [tool("hr_authorize", "HR 本人授權")] : [])],
    activePrompt: prompt, revisions: [prompt],
    hrSandbox: { available, bindingConfigured: true, toolKeys: available ? ["hr_authorize"] : [] },
  };
}

describe("小香 Sandbox 的模擬員工本人", () => {
  it("選了員工才提示正式資料、模型服務與留存邊界", () => {
    expect(renderPicker(null)).not.toContain("正式員工資料");
    const html = renderPicker(alice);
    expect(html).toContain("正式員工資料");
    expect(html).toContain("所選模型服務");
    expect(html).toContain("不傳送 LINE 訊息");
    expect(html).toContain("留在你的 Sandbox session");
    expect(html).toContain("模擬中");
  });

  it("呈現帳號與綁定失敗候選，姓名不解析為 HTML", () => {
    expect(renderPicker(null)).toContain('aria-label="模擬員工本人"');
    const label = hrSandboxEmployeeLabel({ ...bob, displayName: "<script>乙員工</script>" });
    expect(label).toContain("帳號未啟用 · 未綁定 LINE");
    const labelHtml = renderToStaticMarkup(<span>{label}</span>);
    expect(labelHtml).not.toContain("<script>");
    expect(labelHtml).toContain("&lt;script&gt;");
    expect(renderPicker(alice)).not.toContain("<script>甲員工");
  });

  it("缺少 Login channel 與空員工清單都有明確提示", () => {
    const html = renderPicker(null, [], false);
    expect(html).toContain("尚未設定 LINE_LIFF_CHANNEL_ID");
    expect(html).toContain("沒有符合搜尋條件的在職員工");
  });

  it("模擬設定、tools 與測試對話在同一頁；非管理者沒有模擬入口", () => {
    const admin = withClient(<Sandbox />, [alice], sandboxConfig(true));
    for (const text of ["模擬員工本人", "可調用的 tools", "System prompt", "測試對話", "Sandbox session"]) expect(admin).toContain(text);
    const staff = withClient(<Sandbox />, [], sandboxConfig(false));
    expect(staff).toContain("測試對話");
    expect(staff).not.toContain("模擬員工本人");
  });
});
