// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sandbox } from "./Sandbox.js";
import type { SandboxConfig } from "./api.js";

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.unstubAllGlobals();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

function configFor(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    assistantKey: "test", configured: true, providers: { codex: true, gemini: true },
    defaultModel: "gpt-6-luna", activeModel: "gpt-6-luna", fallbackModel: null,
    activeModelUpdatedAt: null, credentialStatus: { codex: "ready", codexLastErrorAt: null },
    models: [
      { id: "gpt-6-luna", label: "GPT-6 Luna", category: "GPT", provider: "openai-codex", supported: true, configured: true, supportsVision: true },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", category: "Gemini", provider: "google", supported: true, configured: true, supportsVision: true },
    ],
    activePrompt: null, revisions: [], tools: [],
    hrSandbox: { available: false, bindingConfigured: false, toolKeys: [] },
    ...overrides,
  };
}

async function mount(initial: SandboxConfig) {
  let config = initial;
  const patches: Array<{ model?: string; fallbackModel?: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === "/api/assistant/sandbox/config") return Response.json(config);
    if (String(url) === "/api/assistant/config" && init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as (typeof patches)[number];
      patches.push(patch);
      config = {
        ...config,
        ...(patch.model ? { activeModel: patch.model, activeModelNeedsSave: false } : {}),
        ...(patch.fallbackModel !== undefined ? { fallbackModel: patch.fallbackModel, fallbackModelNeedsSave: false } : {}),
      };
      config.modelNotice = config.activeModelNeedsSave || config.fallbackModelNeedsSave ? "仍有退役設定待確認" : undefined;
      return Response.json({ activeModel: config.activeModel, fallbackModel: config.fallbackModel, updatedAt: "2026-10-10T00:00:00Z" });
    }
    throw new Error(`測試不應呼叫 ${String(url)}`);
  }));
  client.setQueryData(["assistant", "sandbox", "config"], config);
  client.setQueryData(["assistant", "sandbox", "sessions"], { sessions: [] });
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><Sandbox /></QueryClientProvider></MemoryRouter>));
  return patches;
}

function button(label: string): HTMLButtonElement {
  const element = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  expect(element).toBeDefined();
  return element!;
}

async function save(label: string) {
  await act(async () => {
    button(label).click();
    await vi.waitFor(() => expect(client.getQueryData<SandboxConfig>(["assistant", "sandbox", "config"])?.modelNotice).not.toBe("原模型已退役"));
  });
}

describe("Sandbox 退役模型的確認儲存", () => {
  it("不自動 PATCH；能直接採用已選取的回落模型，儲存後通知消失且按鈕停用", async () => {
    const patches = await mount(configFor({ activeModelNeedsSave: true, modelNotice: "原模型已退役" }));
    expect(patches).toEqual([]);
    expect(button("儲存並套用到小香").disabled).toBe(false);
    await save("儲存並套用到小香");
    expect(patches).toEqual([{ model: "gpt-6-luna" }]);
    expect(host.textContent).not.toContain("原模型已退役");
    expect(button("儲存並套用到小香").disabled).toBe(true);
  });

  it("可以直接確認不使用 fallback，送 null 清除退役值", async () => {
    const patches = await mount(configFor({ fallbackModelNeedsSave: true, modelNotice: "原模型已退役" }));
    expect(button("儲存並套用到小香").disabled).toBe(true);
    expect(button("儲存 fallback 設定").disabled).toBe(false);
    await save("儲存 fallback 設定");
    expect(patches).toEqual([{ fallbackModel: null }]);
    expect(host.textContent).not.toContain("原模型已退役");
    expect(button("儲存 fallback 設定").disabled).toBe(true);
  });

  it("只清除 fallback 不替主模型確認；兩個退役狀態互相獨立", async () => {
    const patches = await mount(configFor({ activeModelNeedsSave: true, fallbackModelNeedsSave: true, modelNotice: "原模型已退役" }));
    await save("儲存 fallback 設定");
    expect(patches).toEqual([{ fallbackModel: null }]);
    expect(host.textContent).toContain("仍有退役設定待確認");
    expect(button("儲存並套用到小香").disabled).toBe(false);
    expect(button("儲存 fallback 設定").disabled).toBe(true);
  });

  it("仍有效而未變更的 active／fallback，維持不能重複儲存", async () => {
    await mount(configFor());
    expect(button("儲存並套用到小香").disabled).toBe(true);
    expect(button("儲存 fallback 設定").disabled).toBe(true);
  });

  it("退役通知不能繞過主要模型的 credential readiness", async () => {
    const config = configFor({ activeModelNeedsSave: true, fallbackModelNeedsSave: true, modelNotice: "原模型已退役" });
    config.providers.codex = false;
    config.credentialStatus.codex = "unconfigured";
    config.models[0]!.configured = false;
    const patches = await mount(config);
    expect(button("儲存並套用到小香").disabled).toBe(true);
    // 清除 fallback 不需要呼叫 provider，仍可操作。
    expect(button("儲存 fallback 設定").disabled).toBe(false);
    button("儲存並套用到小香").click();
    expect(patches).toEqual([]);
  });

  it("退役旗標不允許把 fallback 與 active 設成同一模型", async () => {
    // 退役主模型回落後，可能剛好等於仍有效的原 fallback；仍需先更換其中一個。
    await mount(configFor({ fallbackModel: "gpt-6-luna", activeModelNeedsSave: true }));
    expect(button("儲存並套用到小香").disabled).toBe(true);
    expect(button("儲存 fallback 設定").disabled).toBe(true);
  });
});
