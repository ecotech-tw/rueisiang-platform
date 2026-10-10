import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HrSandboxTester, hrSandboxEmployeeLabel } from "./HrSandboxTester.js";
import type { SandboxConfig } from "./api.js";

const config: SandboxConfig = {
  assistantKey: "test", configured: true, providers: { codex: false, gemini: true }, defaultModel: "gemini", activeModel: "gemini",
  fallbackModel: null, activeModelUpdatedAt: null, credentialStatus: { codex: "unconfigured", codexLastErrorAt: null },
  models: [{ id: "gemini", label: "Gemini 測試模型", category: "test", quota: { rpm: 1, tpm: 1, rpd: 1 }, provider: "google", supported: true, configured: true, supportsVision: true }],
  tools: [], activePrompt: { id: "prompt", assistantKey: "test", revision: 1, systemPrompt: "測試", isActive: true, createdBy: "admin", createdAt: "2026-01-01" },
  revisions: [{ id: "prompt", assistantKey: "test", revision: 1, systemPrompt: "測試", isActive: true, createdBy: "admin", createdAt: "2026-01-01" }],
  hrSandbox: { available: true, bindingConfigured: true, tools: [
    { key: "hr_authorize", label: "HR 本人授權", description: "授權", surfaces: ["sandbox", "line"], requiredPermissions: [], status: "enabled" },
    { key: "hr_get_my_annual_leave", label: "本人特休", description: "特休", surfaces: ["sandbox", "line"], requiredPermissions: [], status: "disabled" },
  ] },
};

function render(patch: Partial<SandboxConfig> = {}, empty = false) {
  const client = new QueryClient();
  client.setQueryData(["assistant", "sandbox", "hr-employees", "", 1], { employees: empty ? [] : [
    { userId: "alice", displayName: "<script>甲員工</script>", employeeNumber: "E001", userStatus: "active", lineBound: true },
    { userId: "bob", displayName: "乙員工", employeeNumber: "E002", userStatus: "disabled", lineBound: false },
  ], page: 1, hasMore: false });
  const html = renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}><HrSandboxTester config={{ ...config, ...patch }} onExit={() => {}} /></QueryClientProvider></MemoryRouter>);
  client.clear();
  return html;
}

describe("小香 HR 模擬本人測試介面", () => {
  it("顯示正式資料與模型服務提示，沒有 session、圖片、思考或一般工具入口", () => {
    const html = render();
    expect(html).toContain("正式員工資料");
    expect(html).toContain("所選模型服務");
    expect(html).toContain("不傳送 LINE 訊息");
    expect(html).toContain("不載入或保存對話與思考內容");
    expect(html).toContain('aria-label="模擬員工本人"');
    expect(html).not.toMatch(/type="file"|Sandbox session|thinking \/ reasoning|crm_search_customers/);
    expect(html).toContain("HR 本人授權");
    expect(html).not.toContain(">本人特休<");
  });

  it("呈現帳號與綁定失敗候選，姓名不解析為 HTML，未選員工不能送出", () => {
    const html = render();
    expect(html).toContain("帳號未啟用");
    const label = hrSandboxEmployeeLabel({ userId: "bob", displayName: "<script>乙員工</script>", employeeNumber: "E002", userStatus: "disabled", lineBound: false });
    expect(label).toContain("帳號未啟用 · 未綁定 LINE");
    const labelHtml = renderToStaticMarkup(<span>{label}</span>);
    expect(labelHtml).not.toContain("<script>");
    expect(labelHtml).toContain("&lt;script&gt;");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>測試本人 HR 查詢<\/button>/);
  });

  it("缺少 Login channel、停用授權工具與空員工清單都有明確提示", () => {
    const html = render({ hrSandbox: { ...config.hrSandbox, bindingConfigured: false, tools: [] } }, true);
    expect(html).toContain("尚未設定 LINE_LIFF_CHANNEL_ID");
    expect(html).toContain("HR 本人授權工具已停用");
    expect(html).toContain("沒有符合搜尋條件的在職員工");
  });
});
