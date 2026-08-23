import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
  diagnosticText,
  providerResponseDiagnostic,
  publicPiErrorMessage,
  serializePiError,
} from "./pi-agent-diagnostics.js";

const model = {
  id: "gpt-5.4",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
} as Model<"openai-codex-responses">;

describe("Pi provider diagnostics", () => {
  it("只保留可安全追蹤 provider response 的 headers", () => {
    expect(providerResponseDiagnostic(model, {
      status: 403,
      headers: {
        "content-type": "text/html",
        "cf-ray": "ray-123",
        "x-request-id": "request-123",
        "x-codex-relay-request-id": "relay-request-123",
        "retry-after": "30",
        server: "cloudflare",
        authorization: "不要記錄",
      },
    })).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
      endpoint: "https://chatgpt.com/backend-api",
      status: 403,
      contentType: "text/html",
      cfRay: "ray-123",
      requestId: "request-123",
      relayRequestId: "relay-request-123",
      retryAfter: "30",
      server: "cloudflare",
    });
  });

  it("會將 HTML provider 錯誤轉成簡短訊息，不把整頁回傳給 UI", () => {
    const error = new Error("<!doctype html><html><head><title>Unable to load site</title></head><body>secret body</body></html>");
    expect(publicPiErrorMessage(error, {
      provider: "openai-codex",
      model: "gpt-5.4",
      status: 403,
      contentType: "text/html",
    })).toBe("AI provider 回傳非預期的 HTML 錯誤頁（HTTP 403），請查看 Worker log。");
  });

  it("即使 provider error 沒有保留 HTML body，也不把 HTML response 原樣回傳", () => {
    expect(publicPiErrorMessage(new Error("upstream failed"), {
      provider: "openai-codex",
      model: "gpt-5.4",
      status: 403,
      contentType: "text/html; charset=UTF-8",
    })).toBe("AI provider 回傳非預期的 HTML 錯誤頁（HTTP 403），請查看 Worker log。");
  });

  it("structured error 會保留 message 與 stack，但會限制長度", () => {
    const error = new Error("x".repeat(2_000));
    const details = serializePiError(error);
    expect(details.name).toBe("Error");
    expect(details.message.length).toBe(1_200);
    expect(details.stack?.length).toBeLessThanOrEqual(2_000);
  });

  it("會壓縮多餘空白與 HTML 內容", () => {
    expect(diagnosticText("<html><style>hidden</style><body>Hello\n world</body></html>"))
      .toBe("Hello world");
  });
});
