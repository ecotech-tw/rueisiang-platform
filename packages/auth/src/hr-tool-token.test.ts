import { describe, expect, it } from "vitest";
import { signHrToolToken, verifyHrToolToken, HR_TOOL_TOKEN_TTL_SECONDS, type HrToolContext } from "./hr-tool-token.js";
import { signPayload } from "./signed.js";

const secret = "hr-token-test-secret";
const now = Date.parse("2026-09-01T00:00:00Z");
const context: HrToolContext = {
  surface: "line",
  assistantKey: "assistant", channelKey: "channel", conversationId: "private-chat", contextGeneration: "",
  runId: "run", lineLoginChannelId: "login-channel", lineUserId: "U-alice",
};
const identity = { userId: "alice", linkVersion: "version-a" };

describe("HR 本輪唯讀 token", () => {
  it("驗簽後只回本人與綁定版本", async () => {
    const token = await signHrToolToken(context, identity, secret, now);
    expect(await verifyHrToolToken(token, context, secret, now)).toEqual(identity);
  });

  it("拒絕竄改、錯誤 secret、缺 token 與過期", async () => {
    const token = await signHrToolToken(context, identity, secret, now);
    expect(await verifyHrToolToken(`${token}x`, context, secret, now)).toBeNull();
    expect(await verifyHrToolToken(token, context, "other-secret", now)).toBeNull();
    expect(await verifyHrToolToken(undefined, context, secret, now)).toBeNull();
    expect(await verifyHrToolToken(token, context, secret, now + HR_TOOL_TOKEN_TTL_SECONDS * 1000)).toBeNull();
  });

  it.each(["assistantKey", "channelKey", "conversationId", "contextGeneration", "runId", "lineLoginChannelId", "lineUserId"] as const)("拒絕跨 %s 重用", async (key) => {
    const token = await signHrToolToken(context, identity, secret, now);
    expect(await verifyHrToolToken(token, { ...context, [key]: "another" }, secret, now)).toBeNull();
  });

  it("Sandbox 與 LINE 不能互用，且不能換操作者", async () => {
    const sandbox: HrToolContext = { ...context, surface: "sandbox", actorUserId: "admin-a" };
    const token = await signHrToolToken(sandbox, identity, secret, now);
    expect(await verifyHrToolToken(token, sandbox, secret, now)).toEqual(identity);
    expect(await verifyHrToolToken(token, { ...sandbox, surface: "line" }, secret, now)).toBeNull();
    expect(await verifyHrToolToken(token, { ...sandbox, actorUserId: "admin-b" }, secret, now)).toBeNull();
    const lineToken = await signHrToolToken(context, identity, secret, now);
    expect(await verifyHrToolToken(lineToken, sandbox, secret, now)).toBeNull();
  });

  it("一般登入或其他用途的簽章不能充當 HR token", async () => {
    const token = await signPayload({ ...context, ...identity, purpose: "session", expiresAt: now / 1000 + 300 }, secret);
    expect(await verifyHrToolToken(token, context, secret, now)).toBeNull();
  });
});
