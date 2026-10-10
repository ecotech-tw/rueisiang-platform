import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  init: vi.fn<() => Promise<void>>(),
  isInClient: vi.fn<() => boolean>(),
  isLoggedIn: vi.fn(() => true),
  getIDToken: vi.fn(() => "verified-on-server"),
}));
vi.mock("@line/liff", () => ({ default: sdk }));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_LIFF_ID", "test-liff-id");
  sdk.init.mockReset().mockResolvedValue(undefined);
  sdk.isInClient.mockReturnValue(false);
});
afterEach(() => vi.unstubAllEnvs());

describe("LIFF 初始化隔離", () => {
  it("設定 LIFF 後一般瀏覽器仍不呼叫 LINE 初始化，也不取得 LINE token", async () => {
    sdk.init.mockRejectedValue(new Error("LINE 無法連線"));
    const { initializeLiff, getLiffIdToken, isLiffClient } = await import("./liff.js");
    await expect(initializeLiff()).resolves.toBeUndefined();
    expect(sdk.init).not.toHaveBeenCalled();
    expect(getLiffIdToken()).toBeNull();
    expect(isLiffClient()).toBe(false);
  });

  it("LINE 入口初始化失敗仍回報錯誤，且允許重試", async () => {
    sdk.isInClient.mockReturnValue(true);
    sdk.init.mockRejectedValueOnce(new Error("LINE 無法連線"));
    const { initializeLiff, getLiffIdToken, isLiffClient } = await import("./liff.js");
    expect(isLiffClient()).toBe(false);
    await expect(initializeLiff()).rejects.toThrow("LINE 無法連線");
    await initializeLiff();
    expect(sdk.init).toHaveBeenCalledTimes(2);
    expect(getLiffIdToken()).toBe("verified-on-server");
    expect(isLiffClient()).toBe(true);
  });
});
