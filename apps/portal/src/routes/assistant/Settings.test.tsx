import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AssistantSettings } from "./Settings.js";
import { Sandbox } from "./Sandbox.js";
import type { AssistantTool, SandboxConfig } from "./api.js";

const hrTools = [
  ["hr_authorize", "HR 本人授權"],
  ["hr_get_my_leave_requests", "查詢本人假單"],
  ["hr_get_my_annual_leave", "查詢本人特休"],
] as const;

function configFor(status: AssistantTool["status"], available = true): SandboxConfig {
  return {
    assistantKey: "test", configured: true, providers: { codex: false, gemini: true }, defaultModel: "gemini", activeModel: "gemini",
    fallbackModel: null, activeModelUpdatedAt: null, credentialStatus: { codex: "unconfigured", codexLastErrorAt: null },
    models: [{ id: "gemini", label: "測試模型", category: "test", provider: "google", supported: true, configured: true, supportsVision: false }],
    activePrompt: null, revisions: [],
    tools: [
      { key: "weather_open_meteo", label: "天氣查詢", description: "測試天氣", surfaces: ["sandbox", "line"], requiredPermissions: [], status: "enabled" },
      ...(available ? hrTools.map(([key, label]) => ({ key, label, description: "本人唯讀", surfaces: ["sandbox" as const, "line" as const], requiredPermissions: [], status })) : []),
    ],
    hrSandbox: { available, bindingConfigured: true, toolKeys: available ? hrTools.map(([key]) => key) : [] },
  };
}

function render(config: SandboxConfig, page: "settings" | "sandbox" = "settings") {
  const client = new QueryClient();
  client.setQueryData(["assistant", "sandbox", "config"], config);
  client.setQueryData(["assistant", "sandbox", "sessions"], { sessions: [] });
  client.setQueryData(["assistant", "sandbox", "hr-employees", "", 1], { employees: [], page: 1, hasMore: false });
  const html = renderToStaticMarkup(
    <MemoryRouter><QueryClientProvider client={client}>
      {page === "sandbox" ? <Sandbox /> : <AssistantSettings />}
    </QueryClientProvider></MemoryRouter>,
  );
  client.clear();
  return html;
}

describe("小香設定頁的 HR 工具控制", () => {
  it.each([
    ["enabled", "已啟用"], ["development", "開發中"], ["disabled", "已停用"],
  ] as const)("HR 工具為 %s 時，設定頁仍提供三個狀態控制且保留一般工具", (status, label) => {
    const config = configFor(status);
    const html = render(config);
    for (const [key, toolLabel] of hrTools) {
      expect(html).toContain(key);
      const controls = html.match(new RegExp(`<button[^>]*aria-label="${toolLabel} 狀態"[^>]*>[\\s\\S]*?</button>`, "g"));
      expect(controls).toHaveLength(1);
      expect(controls![0]).toContain(label);
    }
    expect(html).toContain('aria-label="天氣查詢 狀態"');

  });

  it.each(["settings", "sandbox"] as const)("%s 顯示新模型的正式名稱及退役通知，不解析通知中的 HTML", (page) => {
    const config = configFor("enabled");
    config.activeModel = "gpt-6-luna";
    config.models = [
      { id: "gpt-6-luna", label: "GPT-6 Luna", category: "GPT", provider: "openai-codex", supported: true, configured: true, supportsVision: true },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", category: "GPT", provider: "openai-codex", supported: true, configured: true, supportsVision: true },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", category: "Gemini", provider: "google", supported: true, configured: true, supportsVision: true },
    ];
    config.modelNotice = "<script>原模型已退役</script>，請重新選擇並儲存正式模型。";
    const html = render(config, page);
    expect(html).toContain("GPT-6 Luna");
    expect(html).toContain("重新選擇並儲存正式模型");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    if (page === "sandbox") expect(html).toContain("選擇模型只影響測試");
  });

  it("HR 目錄未授權時，設定頁只顯示伺服器提供的一般工具", () => {
    const html = render(configFor("enabled", false));
    expect(html).toContain('aria-label="天氣查詢 狀態"');
    for (const [key] of hrTools) expect(html).not.toContain(key);
  });
});
