// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startup = vi.hoisted(() => ({
  render: vi.fn(), init: vi.fn<() => Promise<void>>(), isInClient: vi.fn<() => boolean>(),
}));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: startup.render }) }));
vi.mock("./App.js", () => ({ App: () => <p>一般 HR 應用</p> }));
vi.mock("@line/liff", () => ({ default: { init: startup.init, isInClient: startup.isInClient } }));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_LIFF_ID", "test-liff-id");
  startup.render.mockReset();
  startup.init.mockReset().mockRejectedValue(new Error("LINE 無法連線"));
  document.body.innerHTML = '<div id="root"></div>';
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("HR 啟動畫面", () => {
  it("LINE 服務故障不影響一般瀏覽器掛載 HR", async () => {
    startup.isInClient.mockReturnValue(false);
    await import("./main.js");
    await vi.waitFor(() => expect(startup.render).toHaveBeenCalled());
    expect(startup.init).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(startup.render.mock.calls[0]![0])).toContain("一般 HR 應用");
  });

  it("真正 LINE 入口初始化失敗時顯示錯誤與重新載入，不退回一般 HR", async () => {
    startup.isInClient.mockReturnValue(true);
    await import("./main.js");
    await vi.waitFor(() => expect(startup.render).toHaveBeenCalled());
    const markup = renderToStaticMarkup(startup.render.mock.calls[0]![0]);
    expect(markup).toContain("LINE 打卡載入失敗");
    expect(markup).toContain("重新載入");
    expect(markup).not.toContain("一般 HR 應用");
  });
});
