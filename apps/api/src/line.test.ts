import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import {
  ASSISTANT_LINE_QUEUE_MAX_ATTEMPTS,
  claimAssistantLineQueueJob,
  createDatabase,
  ensureAssistantDefaults,
  saveHrRequestDraft,
  setAssistantChannelTools,
  listPendingAssistantLineQueueJobs,
  linkLineAccount,
  unlinkLineAccount,
  recordAssistantRun,
  requeueStaleAssistantLineQueueJobs,
  listAssistantLineMessages,
  reserveAssistantLinePushDelivery,
  syncSystemRoles,
  upsertAssistantLineQueueJob,
  type AssistantLineQueueJobStatus,
} from "@rueisiang/db";
import {
  assistantLineChannels,
  assistantLineGroups,
  assistantLineMessages,
  assistantLinePushDeliveries,
  assistantLineQueueJobs,
  assistantLineReplyBackups,
  assistantRuns,
  assistantHrRequestDrafts,
  assistantToolCalls,
  hrEmployments,
  hrLeaveRequests,
  hrLeaveTypes,
  mediaObjects,
  userRoleAssignments,
  users,
} from "@rueisiang/db/schema";
import type { AssistantToolCall } from "@rueisiang/assistant";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";
import { lineQuestionText } from "./line.js";
import { LineHrSelfService } from "./assistant-hr.js";
import type { PiLineAgentRunRequest, PiLineAgentRunResponse } from "./pi-agent-contract.js";
import { processLineAssistantQueueMessage } from "./routes/webhooks.js";

const AUTH_SECRET = "line-test-auth-secret";
let d1: LocalD1;
let env: Record<string, unknown>;
let piAgentRequests: Array<{ agentName: string; path: string; payload: Record<string, unknown> }>;
let piAgentResponse: PiLineAgentRunResponse;
let piAgentError: string | undefined;
let piAgentErrorToolCalls: AssistantToolCall[] = [];
let piAgentStatus = 503;

function setPiAgentResponse(text: string, usage = { promptTokens: 1, candidateTokens: 2, totalTokens: 3 }): void {
  piAgentResponse = {
    sessionId: "test-session",
    model: "gpt-6-luna",
    result: { text, thoughts: "", toolCalls: [], usage },
  };
}

function piAgentNamespace() {
  return {
    getByName: (agentName: string) => ({
      fetch: async (request: Request) => {
        const payload = await request.json() as Record<string, unknown>;
        const path = new URL(request.url).pathname;
        piAgentRequests.push({ agentName, path, payload });
        if (piAgentError) return Response.json({ error: piAgentError, toolCalls: piAgentErrorToolCalls }, { status: piAgentStatus });
        if (path === "/reset") return Response.json({ sessionId: "reset-session", reset: true });
        return Response.json(piAgentResponse);
      },
    }),
  };
}

function db() {
  return createDatabase(d1 as never);
}

async function hmacBase64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function seedAdmin() {
  await db().insert(users).values({ id: "admin", email: "admin@ecotech.tw", googleName: "管理者", status: "active" });
  await db().insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
}

async function cookie() {
  const token = await signSession(
    newSessionClaims({ id: "admin", email: "admin@ecotech.tw", name: "管理者", pictureUrl: "" }),
    AUTH_SECRET,
  );
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

async function call(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`https://platform.rueisiang.com${path}`, {
    ...init,
    headers: { Cookie: await cookie(), "Content-Type": "application/json", ...(init.headers ?? {}) },
  }), env as never);
}

async function postLine(body: string, secret = "line-secret") {
  return call("/api/webhooks/line", {
    method: "POST",
    headers: { "x-line-signature": await hmacBase64(secret, body) },
    body,
  });
}

function mentionEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    webhookEventId: "evt-1",
    timestamp: Date.now(),
    replyToken: "reply-token-1",
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    message: {
      id: "message-1",
      type: "text",
      text: "@Rueisiang 小香 請幫我查一下",
      mention: { mentionees: [{ isSelf: true }] },
    },
    ...overrides,
  };
}

function userEvent(overrides: Record<string, unknown> = {}) {
  return mentionEvent({
    webhookEventId: "user-evt-1",
    source: { type: "user", userId: "user-1" },
    message: { id: "user-message-1", type: "text", text: "你好" },
    ...overrides,
  });
}

beforeEach(async () => {
  d1 = createLocalD1();
  piAgentRequests = [];
  piAgentError = undefined;
  piAgentErrorToolCalls = [];
  piAgentStatus = 503;
  setPiAgentResponse("Pi 測試回答");
  const lineQueue = {
    send: async (message: unknown) => {
      await processLineAssistantQueueMessage(message, env as never);
    },
  };
  env = {
    DB: d1,
    LINE_ASSISTANT_QUEUE: lineQueue,
    ASSISTANT_CHAT_AGENT: piAgentNamespace(),
    AUTH_SESSION_SECRET: AUTH_SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    LINE_CHANNEL_SECRET: "line-secret",
  };
  await syncSystemRoles(db());
  await seedAdmin();
});

async function enableLineConversation(event: Record<string, unknown>) {
  await postLine(JSON.stringify({ events: [event] }));
  await db().update(assistantLineChannels).set({ enabled: true }).where(eq(assistantLineChannels.assistantKey, "rueisiang-xiaoxiang"));
  const source = event.source as { groupId?: string; roomId?: string; userId?: string };
  const lineGroupId = source.groupId ?? source.roomId ?? source.userId;
  const [group] = await db().select().from(assistantLineGroups).where(eq(assistantLineGroups.lineGroupId, lineGroupId!));
  await db().update(assistantLineGroups).set({ enabled: true }).where(eq(assistantLineGroups.id, group!.id));
  env = { ...env, LINE_CHANNEL_ACCESS_TOKEN: "access-token" };
  return group!;
}

describe("LINE webhook", () => {
  it("用原始文字搭配 mention offset，避免 trim 造成切字位移", () => {
    const rawText = "\n@Rueisiang 小香 今天天氣如何";
    const mentionLength = "@Rueisiang 小香".length;
    expect(lineQuestionText(rawText, { isSelf: true, index: 1, length: mentionLength })).toBe("今天天氣如何");
    expect(lineQuestionText(rawText, { isSelf: true, index: 99, length: 2 })).toBe(rawText.trim());
  });

  it("簽章不正確時不會寫入訊息", async () => {
    const body = JSON.stringify({ events: [mentionEvent()] });
    const response = await call("/api/webhooks/line", {
      method: "POST",
      headers: { "x-line-signature": await hmacBase64("wrong-secret", body) },
      body,
    });
    expect(response.status).toBe(401);
    expect(await db().select().from(assistantLineMessages)).toHaveLength(0);
  });

  it("群組與多人聊天室要 mention，一對一不需要 mention", async () => {
    const body = JSON.stringify({ events: [
      mentionEvent(),
      { ...mentionEvent({ webhookEventId: "evt-2" }), message: { type: "text", text: "一般聊天" } },
      userEvent(),
      {
        ...mentionEvent({ webhookEventId: "room-evt-1", source: { type: "room", roomId: "room-1", userId: "user-1" } }),
        message: { id: "room-message-1", type: "text", text: "多人聊天室的一般聊天" },
      },
    ] });
    const response = await postLine(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "accepted", recorded: 2, ignored: 2 });

    const groups = await db().select().from(assistantLineGroups);
    const messages = await db().select().from(assistantLineMessages);
    const group = groups.find((row) => row.lineGroupId === "group-1");
    const user = groups.find((row) => row.lineGroupId === "user-1");
    const message = messages.find((row) => row.lineGroupId === "group-1");
    const userMessage = messages.find((row) => row.lineGroupId === "user-1");
    expect(group).toMatchObject({ lineGroupId: "group-1", enabled: false });
    expect(message).toMatchObject({ lineGroupId: "group-1", text: "@Rueisiang 小香 請幫我查一下", sourceType: "group" });
    expect(user).toMatchObject({ lineGroupId: "user-1", sourceType: "user", enabled: false });
    expect(userMessage).toMatchObject({ lineGroupId: "user-1", text: "你好", sourceType: "user", lineUserId: "user-1" });
    expect(groups.some((row) => row.lineGroupId === "room-1")).toBe(false);
  });

  it("LINE 重送同一 webhook event 不會重複記錄", async () => {
    const body = JSON.stringify({ events: [mentionEvent()] });
    await postLine(body);
    const response = await postLine(body);
    expect(await response.json()).toMatchObject({ recorded: 0, duplicates: 1 });
    expect(await db().select().from(assistantLineMessages)).toHaveLength(1);
  });

  it("缺少 webhook event id 與 message id 時仍使用穩定 fallback 去重", async () => {
    const body = JSON.stringify({ events: [mentionEvent({
      webhookEventId: undefined,
      message: {
        type: "text",
        text: "@Rueisiang 小香 沒有穩定 ID 的訊息",
        mention: { mentionees: [{ isSelf: true }] },
      },
    })] });
    const first = await postLine(body);
    const second = await postLine(body);
    expect(first.status).toBe(200);
    expect(await second.json()).toMatchObject({ recorded: 0, duplicates: 1 });
    expect(await db().select().from(assistantLineMessages)).toHaveLength(1);
  });

  it("一對一圖片只先保存，下一則文字才會把圖片 metadata 傳給 Pi", async () => {
    const group = await enableLineConversation(userEvent({ webhookEventId: "image-seed" }));
    const imageBytes = new TextEncoder().encode("image");
    const checksumBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", imageBytes));
    const checksum = Array.from(checksumBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const objectKey = "assistant/vision/user-1/2026/08/00000000-0000-0000-0000-000000000101.jpg";
    env = {
      ...env,
      NAS_STORAGE_URL: "https://storage.example.test",
      NAS_STORAGE_TOKEN: "storage-token",
    };
    const requests: Array<{ url: string; method: string; body: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : "" });
      if (url.endsWith("/content")) {
        return new Response(imageBytes, {
          status: 200,
          headers: { "Content-Type": "image/jpeg", "Content-Length": String(imageBytes.byteLength) },
        });
      }
      if (url.startsWith("https://storage.example.test/v1/objects") && method === "POST") {
        return Response.json({ object: { key: objectKey, size: imageBytes.byteLength, checksum, contentType: "image/jpeg" } }, { status: 201 });
      }
      if (url.includes("/profile/user-1")) {
        return Response.json({ displayName: "測試員", pictureUrl: "" });
      }
      return new Response(null, { status: 200 });
    });

    const response = await postLine(JSON.stringify({ events: [userEvent({
      webhookEventId: "image-event",
      replyToken: "image-reply",
      message: {
        id: "image-message",
        type: "image",
        contentProvider: { type: "line" },
      },
    })] }));

    expect(response.status).toBe(200);
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.line.me/v2/bot/profile/user-1",
      "https://api-data.line.me/v2/bot/message/image-message/content",
      "https://storage.example.test/v1/objects?namespace=assistant&scope=vision&scopeId=user-1",
    ]);
    const [message] = await db().select().from(assistantLineMessages).where(eq(assistantLineMessages.webhookEventId, "image-event"));
    const attachments = JSON.parse(message?.attachments ?? "[]") as Array<{ key: string; contentType: string }>;
    expect(message).toMatchObject({
      lineGroupId: "user-1",
      text: "（使用者傳送了一張圖片）",
      messageType: "image",
      imageDownloadStatus: "stored",
      queueRequired: true,
    });
    expect(attachments).toMatchObject([{ key: objectKey, contentType: "image/jpeg" }]);
    expect(await db().select().from(mediaObjects)).toMatchObject([{
      objectKey,
      namespace: "assistant",
      scopeKey: "line:rueisiang-xiaoxiang:user-1",
    }]);
    expect(piAgentRequests.find((request) => request.path === "/run")).toBeUndefined();

    const followUp = await postLine(JSON.stringify({ events: [userEvent({
      webhookEventId: "image-follow-up",
      replyToken: "image-follow-up-reply",
      message: { id: "image-follow-up-message", type: "text", text: "這張圖片是什麼？" },
    })] }));
    expect(followUp.status).toBe(200);
    expect(piAgentRequests.find((request) => request.path === "/run")?.payload).toMatchObject({
      userText: "這張圖片是什麼？",
      attachments: [{ key: objectKey, contentType: "image/jpeg" }],
    });
    expect(group.lineGroupId).toBe("user-1");
  });

  it("群組圖片先保存，下一則標註小香的文字可以沿用同一個 chat 的圖片 metadata", async () => {
    await enableLineConversation(mentionEvent({ webhookEventId: "group-image-seed" }));
    const imageBytes = new Uint8Array([1, 2, 3]);
    const objectKey = "assistant/vision/group-1/2026/08/00000000-0000-0000-0000-000000000102.png";
    const checksumBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", imageBytes));
    const checksum = Array.from(checksumBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    env = {
      ...env,
      NAS_STORAGE_URL: "https://storage.example.test",
      NAS_STORAGE_TOKEN: "storage-token",
    };
    const queued: unknown[] = [];
    env = { ...env, LINE_ASSISTANT_QUEUE: { send: async (message: unknown) => { queued.push(message); } } };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/content")) return new Response(imageBytes, { status: 200, headers: { "Content-Type": "image/png" } });
      if (url.startsWith("https://storage.example.test/v1/objects")) {
        return Response.json({ object: { key: objectKey, size: imageBytes.byteLength, checksum, contentType: "image/png" } }, { status: 201 });
      }
      return new Response(null, { status: 200 });
    });

    const imageEvent = mentionEvent({
      webhookEventId: "group-image-event",
      replyToken: "group-image-reply",
      message: { id: "group-image-message", type: "image", contentProvider: { type: "line" } },
    });
    expect((await postLine(JSON.stringify({ events: [imageEvent] }))).status).toBe(200);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "media", messageType: "image", messageId: "group-image-message" });
    await processLineAssistantQueueMessage(queued.shift(), env as never);

    const chatter = mentionEvent({
      webhookEventId: "group-image-chatter",
      replyToken: "group-image-chatter-reply",
      message: { id: "group-image-chatter-message", type: "text", text: "group chatter" },
    });
    expect((await postLine(JSON.stringify({ events: [chatter] }))).status).toBe(200);
    expect(queued).toHaveLength(0);

    const mention = mentionEvent({
      webhookEventId: "group-image-follow-up",
      replyToken: "group-image-follow-up-reply",
      message: {
      id: "group-image-follow-up-message",
      type: "text",
      text: "@Rueisiang 小香 請看剛才的照片",
      mention: { mentionees: [{ isSelf: true, index: 0, length: "@Rueisiang 小香".length }] },
      },
    });
    expect((await postLine(JSON.stringify({ events: [mention] }))).status).toBe(200);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "assistant",
      questionText: "請看剛才的照片",
    });
    const [storedImage] = await db().select().from(assistantLineMessages).where(eq(assistantLineMessages.webhookEventId, "group-image-event"));
    expect(JSON.parse(storedImage?.attachments ?? "[]")).toMatchObject([{ key: objectKey }]);
    expect(storedImage?.quotedMessageId).toBeNull();
    const [followUp] = await db().select().from(assistantLineMessages).where(eq(assistantLineMessages.webhookEventId, "group-image-follow-up"));
    expect(followUp?.quotedMessageId).toBeNull();
    await processLineAssistantQueueMessage(queued.shift(), env as never);
    expect(piAgentRequests.find((request) => request.path === "/run")?.payload).toMatchObject({
      userText: "請看剛才的照片",
      attachments: [{ key: objectKey, contentType: "image/png" }],
    });
  });

  it("引用圖片的文字先到時會等待圖片落地，圖片完成後再恢復回答", async () => {
    await enableLineConversation(mentionEvent({ webhookEventId: "quote-race-seed" }));
    const imageBytes = new Uint8Array([4, 5, 6]);
    const objectKey = "assistant/vision/group-1/2026/08/00000000-0000-0000-0000-000000000103.png";
    const checksumBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", imageBytes));
    const checksum = Array.from(checksumBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    env = {
      ...env,
      NAS_STORAGE_URL: "https://storage.example.test",
      NAS_STORAGE_TOKEN: "storage-token",
    };
    const queued: unknown[] = [];
    env = { ...env, LINE_ASSISTANT_QUEUE: { send: async (message: unknown) => { queued.push(message); } } };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/content")) return new Response(imageBytes, { status: 200, headers: { "Content-Type": "image/png" } });
      if (url.startsWith("https://storage.example.test/v1/objects")) {
        return Response.json({ object: { key: objectKey, size: imageBytes.byteLength, checksum, contentType: "image/png" } }, { status: 201 });
      }
      return new Response(null, { status: 200 });
    });

    const quote = mentionEvent({
      webhookEventId: "quote-before-image",
      replyToken: "quote-before-image-reply",
      message: {
        id: "quote-before-image-message",
        type: "text",
        text: "@Rueisiang 小香 請看這張圖",
        quotedMessageId: "late-image-message",
        mention: { mentionees: [{ isSelf: true, index: 0, length: "@Rueisiang 小香".length }] },
      },
    });
    expect((await postLine(JSON.stringify({ events: [quote] }))).status).toBe(200);
    expect(queued).toHaveLength(1);
    await processLineAssistantQueueMessage(queued.shift(), env as never);
    const [waiting] = await db().select().from(assistantLineQueueJobs).where(eq(assistantLineQueueJobs.webhookEventId, "quote-before-image"));
    expect(waiting?.status).toBe("waiting");
    expect(piAgentRequests.find((request) => request.path === "/run")).toBeUndefined();

    const image = mentionEvent({
      webhookEventId: "late-image-event",
      replyToken: "late-image-reply",
      message: { id: "late-image-message", type: "image", contentProvider: { type: "line" } },
    });
    expect((await postLine(JSON.stringify({ events: [image] }))).status).toBe(200);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "media", messageId: "late-image-message" });
    await processLineAssistantQueueMessage(queued.shift(), env as never);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "assistant",
      webhookEventId: "quote-before-image",
      quotedMessageId: "late-image-message",
    });
    await processLineAssistantQueueMessage(queued.shift(), env as never);
    expect(piAgentRequests.find((request) => request.path === "/run")?.payload).toMatchObject({
      userText: "請看這張圖",
      quotedMessageId: "late-image-message",
      attachments: [{ key: objectKey, contentType: "image/png" }],
    });
  });

  it("LINE 圖片無法下載時只記錄 failed，不會因圖片事件直接回覆或無限重試", async () => {
    await enableLineConversation(userEvent({ webhookEventId: "expired-image-seed" }));
    env = {
      ...env,
      NAS_STORAGE_URL: "https://storage.example.test",
      NAS_STORAGE_TOKEN: "storage-token",
    };
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/content")) return new Response("gone", { status: 410 });
      return new Response(null, { status: 200 });
    });

    const response = await postLine(JSON.stringify({ events: [userEvent({
      webhookEventId: "expired-image-event",
      replyToken: "expired-image-reply",
      message: { id: "expired-image-message", type: "image", contentProvider: { type: "line" } },
    })] }));

    expect(response.status).toBe(200);
    expect(requests).toContain("https://api-data.line.me/v2/bot/message/expired-image-message/content");
    expect(requests.some((url) => url.endsWith("/message/reply"))).toBe(false);
    expect(piAgentRequests.find((request) => request.path === "/run")).toBeUndefined();
    const [message] = await db().select().from(assistantLineMessages).where(eq(assistantLineMessages.webhookEventId, "expired-image-event"));
    expect(message?.imageDownloadStatus).toBe("failed");
  });
});

describe("LINE Queue outbox", () => {
  it("Queue 暫時不可用時保留 pending，下一次 LINE redelivery 會補送且不重複建立工作", async () => {
    await enableLineConversation(userEvent({ webhookEventId: "outbox-seed" }));
    const event = userEvent({ webhookEventId: "outbox-retry-event" });
    env = {
      ...env,
      LINE_ASSISTANT_QUEUE: {
        send: async () => { throw new Error("queue unavailable"); },
      },
    };

    const failed = await postLine(JSON.stringify({ events: [event] }));
    expect(failed.status).toBe(500);
    const [pending] = await db()
      .select()
      .from(assistantLineQueueJobs)
      .where(eq(assistantLineQueueJobs.webhookEventId, "outbox-retry-event"));
    expect(pending?.status as AssistantLineQueueJobStatus).toBe("pending");

    env = { ...env, LINE_ASSISTANT_QUEUE: { send: async () => undefined } };
    const retried = await postLine(JSON.stringify({ events: [event] }));
    expect(retried.status).toBe(200);
    const jobs = await db()
      .select()
      .from(assistantLineQueueJobs)
      .where(eq(assistantLineQueueJobs.webhookEventId, "outbox-retry-event"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("enqueued");
  });
});

describe("LINE Queue lease、retry budget 與 run audit", () => {
  it("stale requeue 不會回收仍在 lockedUntil 內的 processing job", async () => {
    const { job } = await upsertAssistantLineQueueJob(db(), {
      channelKey: "rueisiang-xiaoxiang",
      webhookEventId: "lease-event",
      payloadEncrypted: "payload",
    });
    const claim = await claimAssistantLineQueueJob(db(), {
      channelKey: job.channelKey,
      webhookEventId: job.webhookEventId,
    });
    expect(claim && "job" in claim).toBe(true);
    if (!claim || !("job" in claim)) return;

    await db().update(assistantLineQueueJobs).set({
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      lockedUntil: new Date(Date.now() + 60_000).toISOString(),
    }).where(eq(assistantLineQueueJobs.id, claim.job.id));
    const activeCount = await requeueStaleAssistantLineQueueJobs(db(), {
      olderThan: new Date(Date.now() - 2 * 60_000).toISOString(),
    });
    const [active] = await db().select().from(assistantLineQueueJobs).where(eq(assistantLineQueueJobs.id, claim.job.id));
    expect(activeCount).toBe(0);
    expect(active?.status).toBe("processing");

    await db().update(assistantLineQueueJobs).set({ lockedUntil: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(assistantLineQueueJobs.id, claim.job.id));
    const expiredCount = await requeueStaleAssistantLineQueueJobs(db(), {
      olderThan: new Date(Date.now() - 2 * 60_000).toISOString(),
    });
    const [expired] = await db().select().from(assistantLineQueueJobs).where(eq(assistantLineQueueJobs.id, claim.job.id));
    expect(expiredCount).toBe(1);
    expect(expired?.status).toBe("pending");
  });

  it("同一個 LINE 對話會用 sequence gate 阻止後來的 Queue 工作越過前一筆", async () => {
    await enableLineConversation(userEvent({ webhookEventId: "order-seed" }));
    const queued: unknown[] = [];
    env = {
      ...env,
      LINE_ASSISTANT_QUEUE: { send: async (message: unknown) => { queued.push(message); } },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/profile/user-1")) {
        return new Response(JSON.stringify({ displayName: "測試員", pictureUrl: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 200 });
    });

    await postLine(JSON.stringify({ events: [userEvent({
      webhookEventId: "order-event-1",
      message: { id: "order-message-1", type: "text", text: "第一筆問題" },
    })] }));
    await postLine(JSON.stringify({ events: [userEvent({
      webhookEventId: "order-event-2",
      message: { id: "order-message-2", type: "text", text: "第二筆問題" },
    })] }));
    expect(queued).toHaveLength(2);

    const first = queued[0];
    const second = queued[1];
    await expect(processLineAssistantQueueMessage(second, env as never))
      .rejects.toMatchObject({ name: "LineQueueConversationOrderError" });
    await processLineAssistantQueueMessage(first, env as never);
    await processLineAssistantQueueMessage(second, env as never);

    expect(piAgentRequests.filter((request) => request.path === "/run").map((request) => request.payload.userText))
      .toEqual(["第一筆問題", "第二筆問題"]);
    const runs = await db().select().from(assistantRuns).where(eq(assistantRuns.channel, "line"));
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === "success")).toBe(true);
  });

  it("同一 run retry 會更新最後狀態、保留 usage 並避免重複 tool audit", async () => {
    const runId = "run-audit-retry";
    const common = {
      id: runId,
      channel: "line" as const,
      assistantKey: "rueisiang-xiaoxiang",
      channelKey: "rueisiang-xiaoxiang",
      groupId: "user-1",
      model: "gemini-3.6-flash",
      promptRevisionId: "prompt-1",
      inputChars: 20,
      durationMs: 100,
    };
    await recordAssistantRun(db(), {
      ...common,
      outputChars: 12,
      usage: { promptTokens: 4, candidateTokens: 5, totalTokens: 9 },
      status: "failed",
      errorMessage: "Push 逾時",
      toolCalls: [{ toolKey: "crm_get_orders", status: "success", durationMs: 40 }],
    });
    await recordAssistantRun(db(), {
      ...common,
      outputChars: 0,
      usage: { promptTokens: 0, candidateTokens: 0, totalTokens: 0 },
      status: "success",
      toolCalls: [],
    });

    const runs = await db().select().from(assistantRuns).where(eq(assistantRuns.id, runId));
    const calls = await db().select().from(assistantToolCalls).where(eq(assistantToolCalls.runId, runId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "success", outputChars: 12, promptTokens: 4, candidateTokens: 5, totalTokens: 9, errorMessage: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolKey: "crm_get_orders", status: "success" });
  });

  it("永久 Gemini 400 會在 reply window 內回覆設定錯誤，不消耗 Queue retry", async () => {
    const group = await enableLineConversation(userEvent({ webhookEventId: "gemini-400-seed" }));
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ error: { code: 400, message: "invalid request" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 200 });
    });

    await processLineAssistantQueueMessage({
      kind: "assistant",
      runId: crypto.randomUUID(),
      assistantKey: "rueisiang-xiaoxiang",
      channelKey: "rueisiang-xiaoxiang",
      groupRowId: group.id,
      lineGroupId: "user-1",
      sourceType: "user",
      webhookEventId: "gemini-400-event",
      replyToken: "gemini-400-reply",
      questionText: "測試永久錯誤",
      replyDeadlineAt: Date.now() + 60_000,
    }, env as never);

    expect(requests.some((url) => url.endsWith("/message/reply"))).toBe(true);
    expect(requests.some((url) => url.endsWith("/message/push"))).toBe(false);
  });

  it("Pi provider 失敗時仍會把已完成的 tool calls 寫入 failed audit", async () => {
    const group = await enableLineConversation(userEvent({ webhookEventId: "tool-diagnostics-seed" }));
    piAgentError = "Pi provider 暫時失敗";
    piAgentErrorToolCalls = [{
      toolKey: "crm_get_orders",
      status: "success",
      args: { customerId: "customer-1" },
      durationMs: 125,
    }];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/profile/user-1")) {
        return new Response(JSON.stringify({ displayName: "測試員", pictureUrl: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 200 });
    });

    const runId = crypto.randomUUID();
    await expect(processLineAssistantQueueMessage({
      kind: "assistant",
      runId,
      assistantKey: "rueisiang-xiaoxiang",
      channelKey: "rueisiang-xiaoxiang",
      groupRowId: group.id,
      lineGroupId: "user-1",
      sourceType: "user",
      contextGeneration: group.contextResetAt ?? "",
      webhookEventId: "tool-diagnostics-event",
      replyToken: "tool-diagnostics-reply",
      questionText: "測試 tool diagnostics",
      replyDeadlineAt: Date.now() + 60_000,
    }, env as never)).rejects.toMatchObject({ name: "PiAgentRequestError" });

    const calls = await db().select().from(assistantToolCalls).where(eq(assistantToolCalls.runId, runId));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolKey: "crm_get_orders", status: "success", durationMs: 125 });
    const [run] = await db().select().from(assistantRuns).where(eq(assistantRuns.id, runId));
    expect(run).toMatchObject({ status: "failed", errorMessage: "Pi provider 暫時失敗" });
  });

  it("Queue 失敗達到上限後標記 failed，outbox 不會再把它送回 Queue", async () => {
    const group = await enableLineConversation(userEvent({ webhookEventId: "retry-budget-seed" }));
    piAgentError = "Pi Agent 暫時故障";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("generativelanguage.googleapis.com")) return new Response("temporary", { status: 500 });
      return new Response(null, { status: 200 });
    });
    const message = {
      kind: "assistant" as const,
      runId: crypto.randomUUID(),
      assistantKey: "rueisiang-xiaoxiang",
      channelKey: "rueisiang-xiaoxiang",
      groupRowId: group.id,
      lineGroupId: "user-1",
      sourceType: "user" as const,
      webhookEventId: "retry-budget-event",
      replyToken: "retry-budget-reply",
      questionText: "測試 retry budget",
      replyDeadlineAt: Date.now() - 1,
    };
    await upsertAssistantLineQueueJob(db(), {
      channelKey: message.channelKey,
      webhookEventId: message.webhookEventId,
      payloadEncrypted: "payload",
    });

    for (let attempt = 0; attempt < ASSISTANT_LINE_QUEUE_MAX_ATTEMPTS; attempt += 1) {
      await expect(processLineAssistantQueueMessage(message, env as never)).rejects.toBeTruthy();
    }
    await expect(processLineAssistantQueueMessage(message, env as never))
      .rejects.toMatchObject({ name: "LineQueueRetryExhaustedError" });
    const [job] = await db().select().from(assistantLineQueueJobs).where(eq(assistantLineQueueJobs.webhookEventId, message.webhookEventId));
    expect(job).toMatchObject({ status: "failed", attempts: ASSISTANT_LINE_QUEUE_MAX_ATTEMPTS });
    expect(await listPendingAssistantLineQueueJobs(db())).toHaveLength(0);
  });

  it("超過 24 小時的 Push retry key 會留下 ambiguous job，不會自動重送", async () => {
    const group = await enableLineConversation(userEvent({ webhookEventId: "expired-key-seed" }));
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: "需要人工 reconciliation 的回答" }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 200 });
    });
    const message = {
      kind: "assistant" as const,
      runId: crypto.randomUUID(),
      assistantKey: "rueisiang-xiaoxiang",
      channelKey: "rueisiang-xiaoxiang",
      groupRowId: group.id,
      lineGroupId: "user-1",
      sourceType: "user" as const,
      webhookEventId: "expired-key-event",
      replyToken: "expired-key-reply",
      questionText: "測試過期 retry key",
      replyDeadlineAt: Date.now() - 1,
    };
    const { job } = await upsertAssistantLineQueueJob(db(), {
      channelKey: message.channelKey,
      webhookEventId: message.webhookEventId,
      payloadEncrypted: "payload",
    });
    await db().update(assistantLineQueueJobs).set({
      createdAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
    }).where(eq(assistantLineQueueJobs.id, job.id));

    await processLineAssistantQueueMessage(message, env as never);
    const [ambiguous] = await db().select().from(assistantLineQueueJobs).where(eq(assistantLineQueueJobs.id, job.id));
    expect(ambiguous?.status).toBe("ambiguous");
    expect(requests.some((url) => url.endsWith("/message/push"))).toBe(false);
  });
});

describe("群組名稱與大頭貼的自動同步", () => {
  /** 讓 webhook 有 access token 可用；沒有 token 就叫不動 LINE 的 API。 */
  async function configureChannel() {
    await call("/api/assistant/line/config", {
      method: "PATCH",
      body: JSON.stringify({
        channelId: "2001234567",
        channelSecret: "line-secret",
        accessToken: "access-token",
        displayName: "Rueisiang 小香",
        enabled: true,
      }),
    });
  }

  function mockSummary(summary: unknown, status = 200) {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/summary")) {
        return new Response(summary === null ? null : JSON.stringify(summary), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 200 });
    });
    return calls;
  }

  async function groupRow() {
    const response = await call("/api/assistant/line/config");
    const body = await response.json() as { groups: Array<{ displayName: string; pictureUrl: string }> };
    return body.groups[0];
  }

  it("新發現的群組會自動補上名稱與大頭貼", async () => {
    await configureChannel();
    mockSummary({ groupId: "group-1", groupName: "倉庫群", pictureUrl: "https://line.example/g1.jpg" });

    await postLine(JSON.stringify({ events: [mentionEvent()] }));

    expect(await groupRow()).toMatchObject({ displayName: "倉庫群", pictureUrl: "https://line.example/g1.jpg" });
  });

  /*
   * 管理員把「專案討論」改成「倉庫群」是有意義的決定，同步不該把它洗掉。
   * 大頭貼沒有這個問題，一律以 LINE 為準。
   */
  it("已經手動命名過的群組，名稱不會被 LINE 蓋掉", async () => {
    await configureChannel();
    mockSummary({ groupId: "group-1", groupName: "LINE 上的原名", pictureUrl: "https://line.example/a.jpg" });
    await postLine(JSON.stringify({ events: [mentionEvent()] }));

    const config = await (await call("/api/assistant/line/config")).json() as { groups: Array<{ id: string }> };
    await call(`/api/assistant/line/groups/${config.groups[0]!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "倉庫群", enabled: true }),
    });

    // 節流：6 小時內不會再同步一次。把上次同步時間往前推，模擬隔天又有人講話。
    await db().update(assistantLineGroups)
      .set({ profileSyncedAt: "2020-01-01T00:00:00.000Z" })
      .where(eq(assistantLineGroups.lineGroupId, "group-1"));

    mockSummary({ groupId: "group-1", groupName: "LINE 上的原名", pictureUrl: "https://line.example/b.jpg" });
    await postLine(JSON.stringify({ events: [mentionEvent({ webhookEventId: "evt-2" })] }));

    expect(await groupRow()).toMatchObject({ displayName: "倉庫群", pictureUrl: "https://line.example/b.jpg" });
  });

  /*
   * 這條是 review 抓到的：只看「名字是不是空的」的話，第一次同步之後名字就有值了，
   * LINE 那邊之後改名永遠跟不上。改成看 display_name_manual。
   */
  it("自動補上的名稱，之後會跟著 LINE 改名一起更新", async () => {
    await configureChannel();
    mockSummary({ groupId: "group-1", groupName: "舊名字", pictureUrl: "https://line.example/a.jpg" });
    await postLine(JSON.stringify({ events: [mentionEvent()] }));
    expect(await groupRow()).toMatchObject({ displayName: "舊名字" });

    await db().update(assistantLineGroups)
      .set({ profileSyncedAt: "2020-01-01T00:00:00.000Z" })
      .where(eq(assistantLineGroups.lineGroupId, "group-1"));

    mockSummary({ groupId: "group-1", groupName: "新名字", pictureUrl: "https://line.example/a.jpg" });
    await postLine(JSON.stringify({ events: [mentionEvent({ webhookEventId: "evt-rename" })] }));

    expect(await groupRow()).toMatchObject({ displayName: "新名字" });
  });

  /** 切開關送的是 { enabled }，不該被當成「人工命名」而把名字鎖住。 */
  it("只切開關不會讓名稱從此不再同步", async () => {
    await configureChannel();
    mockSummary({ groupId: "group-1", groupName: "舊名字", pictureUrl: "" });
    await postLine(JSON.stringify({ events: [mentionEvent()] }));

    const config = await (await call("/api/assistant/line/config")).json() as { groups: Array<{ id: string }> };
    await call(`/api/assistant/line/groups/${config.groups[0]!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });

    await db().update(assistantLineGroups)
      .set({ profileSyncedAt: "2020-01-01T00:00:00.000Z" })
      .where(eq(assistantLineGroups.lineGroupId, "group-1"));
    mockSummary({ groupId: "group-1", groupName: "新名字", pictureUrl: "" });
    await postLine(JSON.stringify({ events: [mentionEvent({ webhookEventId: "evt-after-toggle" })] }));

    expect(await groupRow()).toMatchObject({ displayName: "新名字" });
  });

  /** room 在 Messaging API 裡查不到名稱，打了也只是白打。 */
  it("多人聊天室不會去打那支 API", async () => {
    await configureChannel();
    const calls = mockSummary({ groupName: "不該被讀到" });

    await postLine(JSON.stringify({ events: [mentionEvent({
      webhookEventId: "evt-room",
      source: { type: "room", roomId: "room-1", userId: "user-1" },
    })] }));

    expect(calls.some((url) => url.includes("/summary"))).toBe(false);
  });

  /** 小香被踢出群組會拿到 404。補名稱失敗不該讓收訊息一起失敗。 */
  it("取不到群組資料時，訊息照樣收得下來", async () => {
    await configureChannel();
    mockSummary(null, 404);

    const response = await postLine(JSON.stringify({ events: [mentionEvent()] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recorded: 1 });
    expect(await groupRow()).toMatchObject({ displayName: "", pictureUrl: "" });
  });

  it("一對一對話會同步使用者名稱與大頭貼", async () => {
    await configureChannel();
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/profile/user-1")) {
        return new Response(JSON.stringify({ displayName: "測試員", pictureUrl: "https://line.example/user-1.jpg" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 200 });
    });

    await postLine(JSON.stringify({ events: [userEvent()] }));

    expect(calls).toContain("https://api.line.me/v2/bot/profile/user-1");
    expect(await groupRow()).toMatchObject({
      sourceType: "user",
      displayName: "測試員",
      pictureUrl: "https://line.example/user-1.jpg",
    });
  });
});

describe("LINE channel 後台設定", () => {
  it("可以從後台保存 Channel ID、Secret 與 Access Token，回傳不包含 credential 原值", async () => {
    const response = await call("/api/assistant/line/config", {
      method: "PATCH",
      body: JSON.stringify({
        channelId: "2001234567",
        channelSecret: "secret-from-portal",
        accessToken: "access-token-from-portal",
        displayName: "Rueisiang 小香",
        enabled: true,
      }),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { channel: { channelId: string }; credentials: { channelSecretConfigured: boolean; accessTokenConfigured: boolean }; webhookUrl: string };
    expect(result).toMatchObject({
      channel: { channelId: "2001234567" },
      credentials: { channelSecretConfigured: true, accessTokenConfigured: true },
      webhookUrl: "https://platform.rueisiang.com/api/webhooks/line",
    });
    expect(JSON.stringify(result)).not.toContain("secret-from-portal");
    expect(JSON.stringify(result)).not.toContain("access-token-from-portal");

    const [channel] = await db().select().from(assistantLineChannels).where(eq(assistantLineChannels.assistantKey, "rueisiang-xiaoxiang"));
    expect(channel?.channelSecretEncrypted).toBeTruthy();
    expect(channel?.channelSecretEncrypted).not.toBe("secret-from-portal");
    expect(channel?.accessTokenEncrypted).toBeTruthy();
    expect(channel?.accessTokenEncrypted).not.toBe("access-token-from-portal");
  });

  it("webhook 會優先使用後台保存的 Secret", async () => {
    const settings = await call("/api/assistant/line/config", {
      method: "PATCH",
      body: JSON.stringify({ channelId: "2001234567", channelSecret: "secret-from-portal", displayName: "Rueisiang 小香", enabled: false }),
    });
    expect(settings.status).toBe(200);
    env = { ...env, LINE_CHANNEL_SECRET: "" };
    const body = JSON.stringify({ events: [mentionEvent()] });
    const response = await postLine(body, "secret-from-portal");
    expect(response.status).toBe(200);
  });

  it("後續儲存送出空白憑證時會保留既有密鑰", async () => {
    const first = await call("/api/assistant/line/config", {
      method: "PATCH",
      body: JSON.stringify({ channelId: "2001234567", channelSecret: "stored-secret", accessToken: "stored-token", displayName: "Rueisiang 小香", enabled: false }),
    });
    expect(first.status).toBe(200);

    const second = await call("/api/assistant/line/config", {
      method: "PATCH",
      body: JSON.stringify({ channelId: "2007654321", channelSecret: "", accessToken: "", displayName: "小香新版名稱", enabled: false }),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      channel: { channelId: "2007654321", displayName: "小香新版名稱" },
      credentials: { channelSecretConfigured: true, accessTokenConfigured: true },
    });

    env = { ...env, LINE_CHANNEL_SECRET: "" };
    const response = await postLine(JSON.stringify({ events: [mentionEvent({ webhookEventId: "evt-preserved-secret" })] }), "stored-secret");
    expect(response.status).toBe(200);
  });

  it("LINE 官方帳號改名後仍以 isSelf mention 判斷", async () => {
    const body = JSON.stringify({ events: [mentionEvent({
      webhookEventId: "evt-renamed-account",
      message: {
        id: "message-renamed",
        type: "text",
        text: "@改名後的小香 請繼續處理",
        mention: { mentionees: [{ isSelf: true }] },
      },
    })] });
    const response = await postLine(body);
    expect(response.status).toBe(200);
    expect(await db().select().from(assistantLineMessages)).toHaveLength(1);
  });

  it("已開通的群組會把 prompt、工具與訊息交給 Pi Agent，並記錄 LINE 用量", async () => {
    const firstBody = JSON.stringify({ events: [mentionEvent()] });
    await postLine(firstBody);
    await db().update(assistantLineChannels).set({ enabled: true }).where(eq(assistantLineChannels.assistantKey, "rueisiang-xiaoxiang"));
    const [group] = await db().select().from(assistantLineGroups).where(eq(assistantLineGroups.lineGroupId, "group-1"));
    await db().update(assistantLineGroups).set({ enabled: true }).where(eq(assistantLineGroups.id, group!.id));

    await call("/api/assistant/line/config", {
      method: "PATCH",
      body: JSON.stringify({ channelId: "2001234567", channelSecret: "line-secret", accessToken: "access-token-from-portal", displayName: "Rueisiang 小香", enabled: true }),
    });
    env = { ...env, LINE_CHANNEL_ACCESS_TOKEN: "wrong-env-token" };
    setPiAgentResponse(
      "已收到，我會依照群組內容協助處理。",
      { promptTokens: 10, candidateTokens: 8, totalTokens: 18 },
    );
    const requests: Array<{ url: string; body: string; authorization: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        body: typeof init?.body === "string" ? init.body : "",
        authorization: new Headers(init?.headers).get("authorization") ?? "",
      });
      return new Response(null, { status: 200 });
    });

    const response = await postLine(JSON.stringify({ events: [mentionEvent({ webhookEventId: "evt-2", replyToken: "reply-token-2" })] }));
    expect(response.status).toBe(200);
    // 群組還沒有名字，所以收到訊息時會先去補一次名稱與大頭貼，再跑回覆流程。
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.line.me/v2/bot/group/group-1/summary",
      "https://api.line.me/v2/bot/message/reply",
    ]);
    const agentRequest = piAgentRequests.find((request) => request.path === "/run");
    expect(agentRequest?.agentName).toBe("rueisiang-xiaoxiang:rueisiang-xiaoxiang:group:group-1");
    expect(agentRequest?.payload).toMatchObject({
      model: "gpt-6-luna",
      sourceType: "group",
      lineGroupId: "group-1",
    } satisfies Partial<PiLineAgentRunRequest>);
    expect(agentRequest?.payload.userText).toContain("請幫我查一下");
    expect(agentRequest?.payload.systemPrompt).toContain("LINE 內部助理");
    expect(agentRequest?.payload.toolKeys).toEqual(expect.any(Array));
    const replyRequest = requests.find((request) => request.url.endsWith("/message/reply"));
    expect(replyRequest?.authorization).toBe("Bearer access-token-from-portal");
    expect(replyRequest?.body).toContain('"replyToken":"reply-token-2"');
    expect(replyRequest?.body).toContain("已收到，我會依照群組內容協助處理。");
    const runs = await db().select().from(assistantRuns).where(eq(assistantRuns.channel, "line"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ channel: "line", groupId: "group-1", model: "gpt-6-luna", status: "success", totalTokens: 18 });
  });

  it("LINE 設定失效時仍會記錄失敗並通知群組", async () => {
    await postLine(JSON.stringify({ events: [mentionEvent({ webhookEventId: "evt-config-seed" })] }));
    await db().update(assistantLineChannels).set({ enabled: true }).where(eq(assistantLineChannels.assistantKey, "rueisiang-xiaoxiang"));
    const [group] = await db().select().from(assistantLineGroups).where(eq(assistantLineGroups.lineGroupId, "group-1"));
    await db().update(assistantLineGroups).set({ enabled: true }).where(eq(assistantLineGroups.id, group!.id));
    await call("/api/assistant/line/config", {
      method: "PATCH",
      body: JSON.stringify({ channelId: "2001234567", channelSecret: "line-secret", accessToken: "access-token", displayName: "Rueisiang 小香", enabled: true }),
    });
    piAgentError = "Pi Agent 測試故障";
    piAgentStatus = 400;

    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      requests.push(String(input));
      return new Response(null, { status: 200 });
    });
    const response = await postLine(JSON.stringify({ events: [mentionEvent({ webhookEventId: "evt-invalid-config", replyToken: "reply-invalid" })] }));
    expect(response.status).toBe(200);
    expect(requests).toEqual([
      "https://api.line.me/v2/bot/group/group-1/summary",
      "https://api.line.me/v2/bot/message/reply",
    ]);
    const runs = await db().select().from(assistantRuns).where(eq(assistantRuns.channel, "line"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", model: "gpt-6-luna" });
  });

  it("Codex credential 設定錯誤時不消耗 Queue retry，直接通知群組", async () => {
    await postLine(JSON.stringify({ events: [mentionEvent({ webhookEventId: "evt-credential-seed" })] }));
    await db().update(assistantLineChannels).set({ enabled: true }).where(eq(assistantLineChannels.assistantKey, "rueisiang-xiaoxiang"));
    const [group] = await db().select().from(assistantLineGroups).where(eq(assistantLineGroups.lineGroupId, "group-1"));
    await db().update(assistantLineGroups).set({ enabled: true }).where(eq(assistantLineGroups.id, group!.id));
    await call("/api/assistant/line/config", {
      method: "PATCH",
      body: JSON.stringify({ channelId: "2001234567", channelSecret: "line-secret", accessToken: "access-token", displayName: "Rueisiang 小香", enabled: true }),
    });
    piAgentError = "平台尚未設定 PI_CREDENTIAL_ENCRYPTION_KEY。";
    piAgentStatus = 503;

    const requests: Array<{ url: string; body: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
      return new Response(null, { status: 200 });
    });

    const response = await postLine(JSON.stringify({ events: [mentionEvent({ webhookEventId: "evt-credential-error", replyToken: "reply-credential-error" })] }));
    expect(response.status).toBe(200);
    expect(requests).toEqual([
      { url: "https://api.line.me/v2/bot/group/group-1/summary", body: "" },
      expect.objectContaining({ url: "https://api.line.me/v2/bot/message/reply" }),
    ]);
    expect(requests[1]?.body).toContain("小香目前無法完成回答，請稍後再試。");
    const runs = await db().select().from(assistantRuns).where(eq(assistantRuns.channel, "line"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", errorMessage: "平台尚未設定 PI_CREDENTIAL_ENCRYPTION_KEY。" });
  });

  it("已開通的一對一對話會使用 user ID 回覆", async () => {
    env = { ...env, PI_AGENT_MODEL: "gemini-3.6-flash" };
    await postLine(JSON.stringify({ events: [userEvent()] }));
    const [userGroup] = await db().select().from(assistantLineGroups).where(eq(assistantLineGroups.lineGroupId, "user-1"));
    expect(userGroup?.sourceType).toBe("user");

    await call(`/api/assistant/line/groups/${userGroup!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    await call("/api/assistant/line/config", {
      method: "PATCH",
      body: JSON.stringify({ channelId: "2001234567", channelSecret: "line-secret", accessToken: "access-token", displayName: "Rueisiang 小香", enabled: true }),
    });
    setPiAgentResponse("一對一回答");

    const requests: Array<{ url: string; body: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      requests.push({ url, body });
      if (url.includes("/profile/user-1")) {
        return new Response(JSON.stringify({ displayName: "測試員", pictureUrl: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 200 });
    });

    const response = await postLine(JSON.stringify({ events: [userEvent({
      webhookEventId: "user-evt-run",
      message: { id: "user-message-run", type: "text", text: "請回答我" },
    })] }));
    expect(response.status).toBe(200);
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.line.me/v2/bot/profile/user-1",
      "https://api.line.me/v2/bot/message/reply",
    ]);
    const replyRequest = requests.find((request) => request.url.endsWith("/message/reply"));
    expect(replyRequest?.body).toContain('"replyToken":"reply-token-1"');
    expect(replyRequest?.body).toContain("一對一回答");
    expect(piAgentRequests.find((request) => request.path === "/run")?.payload).toMatchObject({
      model: "gemini-3.6-flash",
      webhookEventId: "user-evt-run",
    });
  });

  it("一對一的 reset backdoor 只切斷上下文，不刪除歷史訊息", async () => {
    const userGroup = await enableLineConversation(userEvent());
    expect(userGroup).toBeTruthy();

    const resetResponse = await postLine(JSON.stringify({ events: [userEvent({
      webhookEventId: "user-evt-reset",
      message: { id: "user-message-reset", type: "text", text: "/reset" },
    })] }));
    expect(resetResponse.status).toBe(200);

    const [updated] = await db().select().from(assistantLineGroups).where(eq(assistantLineGroups.id, userGroup!.id));
    const allMessages = await db().select().from(assistantLineMessages).where(eq(assistantLineMessages.lineGroupId, "user-1"));
    const currentMessages = await listAssistantLineMessages(db(), {
      channelKey: "rueisiang-xiaoxiang",
      lineGroupId: "user-1",
      contextResetAt: updated?.contextResetAt,
    });
    expect(updated?.contextResetAt).toBeTruthy();
    expect(allMessages).toHaveLength(2);
    expect(currentMessages).toHaveLength(0);
    expect(piAgentRequests.find((request) => request.path === "/reset")?.payload).toMatchObject({
      contextGeneration: updated?.contextResetAt,
      lineGroupId: "user-1",
    });
  });
});

describe("LINE HR 敏感回答 delivery", () => {
  it.each(["reply", "push", "push-error", "quota-revoked"])("%s 不保存回答或 thought，Push 前再次查核綁定", async (mode) => {
    const group = await enableLineConversation(userEvent({ webhookEventId: "hr-delivery-seed" }));
    await db().insert(hrEmployments).values({ id: "hr-admin", employeeUserId: "admin", employeeNumber: "HR-ADMIN" });
    await linkLineAccount(db(), "admin", { channelId: "hr-login", lineUserId: "user-1" });
    await ensureAssistantDefaults(db(), { assistantKey: "rueisiang-xiaoxiang", defaultModel: "gpt-6-luna", defaultPrompt: "HR 測試", toolKeys: ["hr_authorize"] });
    await setAssistantChannelTools(db(), { channelKey: "rueisiang-xiaoxiang", toolKeys: ["hr_authorize"], updatedBy: "admin" });
    env.LINE_LIFF_CHANNEL_ID = "hr-login";
    const runId = crypto.randomUUID();
    const context = {
      assistantKey: "rueisiang-xiaoxiang", channelKey: "rueisiang-xiaoxiang", groupRowId: group.id,
      lineGroupId: "user-1", sourceType: "user" as const, contextGeneration: group.contextResetAt ?? "",
      webhookEventId: "hr-delivery-event", runId,
    };
    const hrSelf = new LineHrSelfService(db(), env as never, { ...context, model: "gpt-6-luna", systemPrompt: "", userText: "查假", toolKeys: ["hr_authorize"] });
    await hrSelf.authorize();
    setPiAgentResponse("HR-機密假單回答");
    piAgentResponse.privateHrRun = true;
    piAgentResponse.hrAuthorization = hrSelf.authorization;
    piAgentResponse.result.thoughts = "HR-機密thought";
    piAgentResponse.result.toolCalls = [{ toolKey: "hr_authorize", status: "success", durationMs: 1 }];
    const logs = [vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const requests: Array<{ url: string; body: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      requests.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(url).endsWith("/message/quota/consumption")) {
        if (mode === "quota-revoked") await unlinkLineAccount(db(), "admin");
        return Response.json({ totalUsage: 0 });
      }
      if (mode === "push-error" && String(url).endsWith("/message/push")) return new Response("HR-機密假單回答 HR-機密thought", { status: 400 });
      return new Response(null, { status: 200 });
    });
    const delivery = processLineAssistantQueueMessage({
      ...context, kind: "assistant", replyToken: "hr-reply", questionText: "查我的假單",
      replyDeadlineAt: mode === "reply" ? Date.now() + 60_000 : Date.now() - 1,
    }, env as never);
    await delivery;
    if (mode === "quota-revoked") {
      expect(await db().select().from(assistantRuns).where(eq(assistantRuns.id, runId))).toEqual([expect.objectContaining({ status: "failed" })]);
    }
    const sent = requests.filter((request) => /\/message\/(reply|push)$/.test(request.url));
    if (mode === "quota-revoked") expect(sent).toHaveLength(0);
    else expect(sent).toEqual([expect.objectContaining({ url: expect.stringContaining(`/message/${mode === "reply" ? "reply" : "push"}`), body: expect.stringContaining("HR-機密假單回答") })]);
    expect(await db().select().from(assistantLineReplyBackups).where(eq(assistantLineReplyBackups.runId, runId))).toEqual([]);
    for (const rows of [await db().select().from(assistantRuns), await db().select().from(assistantToolCalls), await db().select().from(assistantLineMessages)]) {
      expect(JSON.stringify(rows)).not.toMatch(/HR-機密假單回答|HR-機密thought|linkVersion/);
    }
    expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toMatch(/HR-機密假單回答|HR-機密thought|linkVersion/);
  });
});

describe("LINE 申請草稿：確認卡片與按鈕", () => {
  const DRAFT_TOOLS = ["hr_authorize", "hr_request_draft_get", "hr_request_draft_save", "hr_request_draft_cancel"];
  const complete = { kind: "leave", leaveTypeId: "leave-personal", startsAt: "2026-03-03 09:00", endsAt: "2026-03-03 12:00", reason: "看醫生" };
  let group: { id: string; contextResetAt: string | null };
  let sent: Array<{ url: string; body: { replyToken?: string; to?: string; messages: Array<Record<string, unknown>> } }>;

  const scope = () => ({ assistantKey: "rueisiang-xiaoxiang", surface: "line" as const, channelKey: "rueisiang-xiaoxiang", conversationKey: group.id, userId: "admin" });
  const postbackEvent = (data: string, overrides: Record<string, unknown> = {}) => ({
    type: "postback", webhookEventId: `postback-${crypto.randomUUID()}`, timestamp: Date.now(), replyToken: "postback-reply",
    source: { type: "user", userId: "user-1" }, postback: { data }, ...overrides,
  });
  const press = (data: string, overrides: Record<string, unknown> = {}) => postLine(JSON.stringify({ events: [postbackEvent(data, overrides)] }));
  const replies = () => sent.filter((request) => request.url.endsWith("/message/reply")).map((request) => String(request.body.messages[0]!.text));
  const leaves = () => db().select().from(hrLeaveRequests);

  beforeEach(async () => {
    group = await enableLineConversation(userEvent({ webhookEventId: "draft-seed" }));
    // 申請人自己不能審自己的單；另一位 HR 管理者當審核者。
    await db().insert(users).values({ id: "boss", email: "boss@ecotech.tw", googleName: "主管", status: "active" });
    await db().insert(userRoleAssignments).values({ userId: "boss", roleId: "role-admin" });
    await db().insert(hrEmployments).values({ id: "hr-admin", employeeUserId: "admin", employeeNumber: "HR-ADMIN" });
    await db().insert(hrLeaveTypes).values({ id: "leave-personal", name: "事假", leaveKind: "other", createdBy: "admin" });
    await linkLineAccount(db(), "admin", { channelId: "hr-login", lineUserId: "user-1" });
    await ensureAssistantDefaults(db(), { assistantKey: "rueisiang-xiaoxiang", defaultModel: "gpt-6-luna", defaultPrompt: "HR 測試", toolKeys: DRAFT_TOOLS });
    await setAssistantChannelTools(db(), { channelKey: "rueisiang-xiaoxiang", toolKeys: DRAFT_TOOLS, updatedBy: "admin" });
    env.LINE_LIFF_CHANNEL_ID = "hr-login";
    piAgentRequests = [];
    sent = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (/\/message\/(reply|push)$/.test(String(url))) sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      if (String(url).endsWith("/message/quota/consumption")) return Response.json({ totalUsage: 0 });
      return new Response(null, { status: 200 });
    });
  });

  async function runDraftTurn(replyDeadlineAt = Date.now() + 60_000) {
    const runId = crypto.randomUUID();
    const context = {
      assistantKey: "rueisiang-xiaoxiang", channelKey: "rueisiang-xiaoxiang", groupRowId: group.id,
      lineGroupId: "user-1", sourceType: "user" as const, contextGeneration: group.contextResetAt ?? "",
      webhookEventId: `draft-event-${runId}`, runId,
    };
    const hrSelf = new LineHrSelfService(db(), env as never, { ...context, model: "gpt-6-luna", systemPrompt: "", userText: "請假", toolKeys: DRAFT_TOOLS });
    await hrSelf.authorize();
    setPiAgentResponse("請核對下面的卡片，沒問題就按確認送出。");
    piAgentResponse.privateHrRun = true;
    piAgentResponse.hrAuthorization = hrSelf.authorization;
    piAgentResponse.result.toolCalls = [
      { toolKey: "hr_authorize", status: "success", durationMs: 1 },
      { toolKey: "hr_request_draft_save", status: "success", durationMs: 1 },
    ];
    await processLineAssistantQueueMessage({ ...context, kind: "assistant", replyToken: "draft-reply", questionText: "我要請假", replyDeadlineAt }, env as never);
  }

  type FlexText = { type: "text"; text: string };
  type FlexCard = {
    type: string; altText: string;
    contents: {
      type: string;
      header: { contents: FlexText[] };
      body: { contents: Array<{ contents: [FlexText, FlexText] }> };
      footer: { contents: Array<{ type: string; style?: string; action?: { type: string; label: string; data: string } }> };
    };
  };
  const cardRowsOf = (card: FlexCard) => card.contents.body.contents.map((row) => ({ label: row.contents[0].text, value: row.contents[1].text }));
  const cardButtonsOf = (card: FlexCard) => card.contents.footer.contents.filter((item) => item.type === "button");

  it("草稿存齊的那一輪：回覆後面接一張卡片，內容排成標籤與值，兩顆按鈕帶草稿 id 與版本", async () => {
    const draft = await saveHrRequestDraft(db(), scope(), complete);
    await runDraftTurn();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.messages).toHaveLength(2);
    const [text, card] = sent[0]!.body.messages as unknown as [{ type: string; text: string }, FlexCard];
    expect(text).toMatchObject({ type: "text", text: "請核對下面的卡片，沒問題就按確認送出。" });
    // 通知上只看得到替代文字，不能帶申請內容。
    expect(card).toMatchObject({ type: "flex", altText: "請確認請假申請", contents: { type: "bubble" } });
    expect(card.contents.header.contents.map((item) => item.text)).toEqual(["請假申請", "尚未送出"]);
    // 卡片上的每一列就是草稿算出來的那幾列，不是另外排的一份。
    expect(cardRowsOf(card)).toEqual(draft.cardRows);
    expect(cardRowsOf(card).map((row) => row.label)).toEqual(["假別", "開始", "結束", "時數", "原因"]);
    // 色碼抄自共用的 theme token：那邊改了這裡沒跟，這個測試會擋下來。
    const theme = readFileSync(new URL("../../../packages/ui/theme.css", import.meta.url), "utf8");
    for (const name of ["brand", "brand-dark", "brand-soft", "ink", "muted", "soft-line"]) {
      expect(JSON.stringify(card)).toContain(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`).exec(theme)![1]);
    }
    // 主要動作與取消長得不一樣，才不容易按錯。
    expect(cardButtonsOf(card)).toMatchObject([
      { style: "primary", action: { type: "postback", label: "確認送出", data: `hr_draft:submit:${draft.id}:${draft.revision}` } },
      { style: "link", action: { type: "postback", label: "取消", data: `hr_draft:cancel:${draft.id}:${draft.revision}` } },
    ]);
    // 發卡片不等於送出。
    expect(await leaves()).toHaveLength(0);
  });

  it("給模型的草稿不帶 cardRows：內容跟 card 一樣，原因不必在工具結果裡出現兩次", async () => {
    const context = {
      assistantKey: "rueisiang-xiaoxiang", channelKey: "rueisiang-xiaoxiang", groupRowId: group.id,
      lineGroupId: "user-1", sourceType: "user" as const, contextGeneration: group.contextResetAt ?? "",
      webhookEventId: "draft-event-model", runId: crypto.randomUUID(),
    };
    const hrSelf = new LineHrSelfService(db(), env as never, { ...context, model: "gpt-6-luna", systemPrompt: "", userText: "請假", toolKeys: DRAFT_TOOLS });
    await hrSelf.authorize();
    const saved = (await hrSelf.saveRequestDraft(complete)).draft;
    expect(saved).toMatchObject({ status: "ready", card: expect.stringContaining("原因：") });
    expect(saved).not.toHaveProperty("cardRows");
    expect((await hrSelf.requestDraft()).draft).not.toHaveProperty("cardRows");
  });

  it("Reply 來不及改走 Push 時，卡片與按鈕一樣跟著送", async () => {
    await saveHrRequestDraft(db(), scope(), complete);
    await runDraftTurn(Date.now() - 1);
    const push = sent.find((request) => request.url.endsWith("/message/push"));
    expect(push!.body.messages.map((message) => message.type)).toEqual(["text", "flex"]);
  });

  it("草稿還沒齊就不發卡片；有草稿而且拿得到讀草稿的工具時，下一輪的 system prompt 會提醒", async () => {
    await saveHrRequestDraft(db(), scope(), { kind: "leave", reason: "看醫生" });
    await runDraftTurn();
    expect(sent[0]!.body.messages).toHaveLength(1);
    const prompt = String(piAgentRequests.at(-1)!.payload.systemPrompt);
    expect(prompt).toContain("還沒完成的請假申請草稿");
    // 每一輪都帶著「先存，再複述」的規則：模型不記得上一輪，沒存進草稿的東西下一輪就不見了。
    expect(prompt).toContain("先呼叫 hr_request_draft_save 存進去，再回覆");
    expect(prompt).toContain("不要先問「是不是這樣」等他回答才存");
    expect(prompt).not.toContain("看醫生");
    // 工具被停用後這個私訊就拿不到讀草稿的工具，也就不提醒。
    await setAssistantChannelTools(db(), { channelKey: "rueisiang-xiaoxiang", toolKeys: ["hr_authorize"], updatedBy: "admin" });
    setPiAgentResponse("一般回答");
    await postLine(JSON.stringify({ events: [userEvent({ webhookEventId: "after-revoke", message: { id: "m-2", type: "text", text: "你好" } })] }));
    expect(String(piAgentRequests.at(-1)!.payload.systemPrompt)).not.toContain("申請草稿");
  });

  it("按確認送出：不經過模型，建立待審的請假並用固定句子回覆；再按一次不會重複送", async () => {
    const draft = await saveHrRequestDraft(db(), scope(), complete);
    expect((await press(`hr_draft:submit:${draft.id}:${draft.revision}`)).status).toBe(200);
    expect(piAgentRequests).toHaveLength(0);
    expect(await leaves()).toEqual([expect.objectContaining({ status: "pending", startsAt: "2026-03-03 01:00:00", endsAt: "2026-03-03 04:00:00", createdBy: "admin", approverUserId: "boss" })]);
    expect(replies()).toEqual(["已送出請假申請，等候審核。\n假別：事假\n開始：2026-03-03（週二）09:00\n結束：2026-03-03（週二）12:00\n時數：3 小時\n原因：看醫生"]);
    await press(`hr_draft:submit:${draft.id}:${draft.revision}`);
    expect(replies()[1]).toBe("這張請假申請已經送出過了，不會重複送出。");
    expect(await leaves()).toHaveLength(1);
    // 按鈕事件不是對話內容，不進訊息紀錄。
    expect((await db().select().from(assistantLineMessages)).map((row) => row.webhookEventId)).toEqual(["draft-seed"]);
  });

  it("LINE 重送同一個按鈕事件：只有一張申請，第二次回的是已經送出過", async () => {
    const draft = await saveHrRequestDraft(db(), scope(), complete);
    const event = postbackEvent(`hr_draft:submit:${draft.id}:${draft.revision}`);
    await postLine(JSON.stringify({ events: [event] }));
    await postLine(JSON.stringify({ events: [event] }));
    expect(await leaves()).toHaveLength(1);
    expect(replies().map((text) => text.split("\n")[0])).toEqual(["已送出請假申請，等候審核。", "這張請假申請已經送出過了，不會重複送出。"]);
  });

  it("傳 /reset 之後草稿被收掉，之前那張卡片的按鈕失效", async () => {
    const draft = await saveHrRequestDraft(db(), scope(), complete);
    await postLine(JSON.stringify({ events: [userEvent({ webhookEventId: "reset-evt", message: { id: "m-reset", type: "text", text: "/reset" } })] }));
    expect((await db().select().from(assistantHrRequestDrafts))[0]!.status).toBe("cancelled");
    sent = [];
    await press(`hr_draft:submit:${draft.id}:${draft.revision}`);
    expect(replies()[0]).toContain("已經不在了");
    expect(await leaves()).toHaveLength(0);
  });

  it("LINE 帳號換綁給另一位員工之後：前一個人的草稿不會出現在他的提示裡，他按舊卡片也送不出去", async () => {
    const draft = await saveHrRequestDraft(db(), scope(), complete);
    await unlinkLineAccount(db(), "admin");
    await db().insert(users).values({ id: "newcomer", email: "newcomer@ecotech.tw", googleName: "新同事", status: "active" });
    await db().insert(hrEmployments).values({ id: "hr-newcomer", employeeUserId: "newcomer", employeeNumber: "HR-N" });
    await linkLineAccount(db(), "newcomer", { channelId: "hr-login", lineUserId: "user-1" });
    setPiAgentResponse("一般回答");
    await postLine(JSON.stringify({ events: [userEvent({ webhookEventId: "after-rebind", message: { id: "m-3", type: "text", text: "你好" } })] }));
    const rebound = String(piAgentRequests.at(-1)!.payload.systemPrompt);
    expect(rebound).not.toContain("還沒完成的");
    expect(rebound).toContain("這段對話目前沒有進行中的申請草稿");
    sent = [];
    await press(`hr_draft:submit:${draft.id}:${draft.revision}`);
    expect(replies()[0]).toContain("已經不在了");
    expect(await leaves()).toHaveLength(0);
  });

  it("還沒有草稿的第一句話：規則已經在 system prompt 裡，模型才知道一開口就要先開草稿", async () => {
    setPiAgentResponse("一般回答");
    await postLine(JSON.stringify({ events: [userEvent({ webhookEventId: "first-turn", message: { id: "m-first", type: "text", text: "我想請假" } })] }));
    const prompt = String(piAgentRequests.at(-1)!.payload.systemPrompt);
    expect(prompt).toContain("員工一說要申請");
    expect(prompt).toContain("只知道是哪一種申請也要存");
    expect(prompt).toContain("這段對話目前沒有進行中的申請草稿");
    expect(prompt).toContain("寫進 notes 存起來");
    // 只給存、沒給讀：模型讀不到草稿，這套流程走不通，不給規則。
    await setAssistantChannelTools(db(), { channelKey: "rueisiang-xiaoxiang", toolKeys: ["hr_authorize", "hr_request_draft_save"], updatedBy: "admin" });
    await postLine(JSON.stringify({ events: [userEvent({ webhookEventId: "save-only", message: { id: "m-save-only", type: "text", text: "我想請假" } })] }));
    expect(String(piAgentRequests.at(-1)!.payload.systemPrompt)).not.toContain("申請草稿");
    // 工具都有，但這個 LINE 帳號沒有綁定員工：授權一定失敗，也不給規則。
    await setAssistantChannelTools(db(), { channelKey: "rueisiang-xiaoxiang", toolKeys: DRAFT_TOOLS, updatedBy: "admin" });
    await unlinkLineAccount(db(), "admin");
    await postLine(JSON.stringify({ events: [userEvent({ webhookEventId: "unbound", message: { id: "m-unbound", type: "text", text: "我想請假" } })] }));
    expect(String(piAgentRequests.at(-1)!.payload.systemPrompt)).not.toContain("申請草稿");
    // 群組拿不到草稿工具，也就不帶這段規則。
    const group = mentionEvent({ webhookEventId: "group-turn" });
    await enableLineConversation(group);
    await postLine(JSON.stringify({ events: [mentionEvent({ webhookEventId: "group-turn-2", message: { id: "m-g2", type: "text", text: "@Rueisiang 小香 我想請假", mention: { mentionees: [{ isSelf: true }] } } })] }));
    expect(String(piAgentRequests.at(-1)!.payload.systemPrompt)).not.toContain("申請草稿");
  });

  it("卡片與按鈕符合 LINE 的訊息限制：一千字的原因也送得出去", async () => {
    const draft = await saveHrRequestDraft(db(), scope(), { ...complete, reason: "長".repeat(1000) });
    await runDraftTurn();
    const messages = sent[0]!.body.messages;
    expect(messages.length).toBeLessThanOrEqual(5);
    const card = messages[1] as unknown as FlexCard;
    expect(cardRowsOf(card).at(-1)).toEqual({ label: "原因", value: "長".repeat(1000) });
    expect(card.altText.length).toBeLessThanOrEqual(400);
    // 一張 bubble 的 JSON 上限是 30KB（照位元組算，中文一個字三個位元組）。
    expect(new TextEncoder().encode(JSON.stringify(card.contents)).length).toBeLessThanOrEqual(30_000);
    // Flex 的文字不能是空字串，有一個就整則被拒收。
    expect(JSON.stringify(card)).not.toContain('"text":""');
    expect(draft.cardRows!.every((row) => row.value.length > 0)).toBe(true);
    for (const button of cardButtonsOf(card)) {
      expect(button.action!.label.length).toBeLessThanOrEqual(20);
      expect(button.action!.data.length).toBeLessThanOrEqual(300);
    }
  });

  it("按取消：丟掉草稿，沒有建立申請", async () => {
    const draft = await saveHrRequestDraft(db(), scope(), complete);
    await press(`hr_draft:cancel:${draft.id}:${draft.revision}`);
    expect(replies()).toEqual(["已取消這張請假草稿，沒有送出任何申請。"]);
    expect(await leaves()).toHaveLength(0);
    expect((await db().select().from(assistantHrRequestDrafts))[0]!.status).toBe("cancelled");
  });

  it("舊卡片、別人的按鈕、群組裡的按鈕、亂填的 data 都不會建立申請", async () => {
    const shown = await saveHrRequestDraft(db(), scope(), complete);
    await saveHrRequestDraft(db(), scope(), { kind: "leave", reason: "改成回診" });
    await press(`hr_draft:submit:${shown.id}:${shown.revision}`);
    expect(replies()).toEqual(["這張卡片的內容後來有更新，請以最新的請假確認卡片為準。"]);

    // 另一位綁定了 LINE 的員工拿到同一個按鈕資料：身分是他自己，草稿不是他的。
    await db().insert(users).values({ id: "mallory", email: "mallory@ecotech.tw", googleName: "別人", status: "active" });
    await db().insert(hrEmployments).values({ id: "hr-mallory", employeeUserId: "mallory", employeeNumber: "HR-M" });
    await linkLineAccount(db(), "mallory", { channelId: "hr-login", lineUserId: "user-2" });
    await enableLineConversation(userEvent({ webhookEventId: "mallory-seed", source: { type: "user", userId: "user-2" }, message: { id: "m-9", type: "text", text: "你好" } }));
    const latest = (await db().select().from(assistantHrRequestDrafts))[0]!;
    sent = [];
    await press(`hr_draft:submit:${latest.id}:${latest.revision}`, { source: { type: "user", userId: "user-2" } });
    expect(replies()).toEqual(["這張申請草稿已經不在了（可能已經取消，或超過 24 小時沒有更新）。需要的話請重新跟我說一次。"]);

    sent = [];
    await press(`hr_draft:submit:${latest.id}:${latest.revision}`, { source: { type: "group", groupId: "group-1", userId: "user-1" } });
    await press("hr_draft:submit:not-a-uuid:1");
    await press(`hr_draft:approve:${latest.id}:${latest.revision}`);
    await press(`other_feature:${latest.id}`);
    expect(sent).toHaveLength(0);
    expect(await leaves()).toHaveLength(0);
    expect((await db().select().from(assistantHrRequestDrafts))[0]!.status).toBe("open");
  });

  it.each(["解除綁定", "收回草稿工具授權", "帳號停權", "channel 停用"])("%s 之後按鈕失效，不會送出", async (change) => {
    const draft = await saveHrRequestDraft(db(), scope(), complete);
    if (change === "解除綁定") await unlinkLineAccount(db(), "admin");
    if (change === "收回草稿工具授權") await setAssistantChannelTools(db(), { channelKey: "rueisiang-xiaoxiang", toolKeys: ["hr_authorize", "hr_request_draft_get"], updatedBy: "admin" });
    if (change === "帳號停權") await db().update(users).set({ status: "disabled" }).where(eq(users.id, "admin"));
    if (change === "channel 停用") await db().update(assistantLineChannels).set({ enabled: false });
    await press(`hr_draft:submit:${draft.id}:${draft.revision}`);
    expect(await leaves()).toHaveLength(0);
    if (change === "channel 停用") expect(sent).toHaveLength(0);
    else expect(replies()[0]).toMatch(/綁定|授權|在職/);
    expect(replies().join("")).not.toContain("已送出");
  });
});

describe("LINE Reply deadline 與 fixed-window Push", () => {
  it("進入十秒安全緩衝區時先回覆系統繁忙，再用受限 Push 傳完整結果", async () => {
    const group = await enableLineConversation(userEvent({ webhookEventId: "deadline-seed" }));
    setPiAgentResponse("安全緩衝區完成的回答");
    const requests: Array<{ url: string; body: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      if (url.endsWith("/message/quota/consumption")) {
        return new Response(JSON.stringify({ totalUsage: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/profile/user-1")) {
        return new Response(JSON.stringify({ displayName: "測試員", pictureUrl: "" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 200 });
    });

    await processLineAssistantQueueMessage({
      kind: "assistant",
      runId: crypto.randomUUID(),
      assistantKey: "rueisiang-xiaoxiang",
      channelKey: "rueisiang-xiaoxiang",
      groupRowId: group.id,
      lineGroupId: "user-1",
      sourceType: "user",
      webhookEventId: "deadline-event",
      replyToken: "deadline-reply-token",
      questionText: "已接近期限",
      replyDeadlineAt: Date.now() + 5_000,
    }, env as never);

    const reply = requests.find((request) => request.url.endsWith("/message/reply"));
    const push = requests.find((request) => request.url.endsWith("/message/push"));
    expect(reply?.body).toContain("系統繁忙，請稍後再試。");
    expect(reply?.body).not.toContain("安全緩衝區完成的回答");
    expect(push?.body).toContain("安全緩衝區完成的回答");
  });

  it("reply token 已過期時才改用 Push，並同時保存對話關聯與逐筆 ledger", async () => {
    const group = await enableLineConversation(userEvent({ webhookEventId: "push-seed" }));
    setPiAgentResponse("逾時後的完整回答");
    const requests: Array<{ url: string; body: string; retryKey: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        body: typeof init?.body === "string" ? init.body : "",
        retryKey: new Headers(init?.headers).get("x-line-retry-key") ?? "",
      });
      if (url.endsWith("/message/quota/consumption")) {
        return new Response(JSON.stringify({ totalUsage: 190 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/profile/user-1")) {
        return new Response(JSON.stringify({ displayName: "測試員", pictureUrl: "" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 200 });
    });

    const runId = crypto.randomUUID();
    await processLineAssistantQueueMessage({
      kind: "assistant",
      runId,
      assistantKey: "rueisiang-xiaoxiang",
      channelKey: "rueisiang-xiaoxiang",
      groupRowId: group.id,
      lineGroupId: "user-1",
      sourceType: "user",
      contextGeneration: group.contextResetAt ?? "",
      webhookEventId: "push-expired-event",
      replyToken: "expired-reply-token",
      questionText: "請回答逾時問題",
      replyDeadlineAt: Date.now() - 1,
    }, env as never);

    expect(requests.some((request) => request.url.endsWith("/message/reply"))).toBe(false);
    const push = requests.find((request) => request.url.endsWith("/message/push"));
    expect(push).toMatchObject({ retryKey: runId });
    expect(push?.body).toContain("逾時後的完整回答");
    const [delivery] = await db().select().from(assistantLinePushDeliveries).where(eq(assistantLinePushDeliveries.runId, runId));
    expect(delivery).toMatchObject({ groupId: group.id, lineGroupId: "user-1", recipientCount: 1, remoteUsage: 190, status: "sent" });
    const [backup] = await db().select().from(assistantLineReplyBackups).where(eq(assistantLineReplyBackups.runId, runId));
    expect(backup).toMatchObject({ groupId: group.id, lineGroupId: "user-1", responseText: "逾時後的完整回答" });
  });

  it("LINE 回報已達 200 位收件者時不送 Push，只保留 skipped ledger 與完整回答", async () => {
    const group = await enableLineConversation(userEvent({ webhookEventId: "quota-seed" }));
    setPiAgentResponse("額度滿時保留的回答");
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/message/quota/consumption")) {
        return new Response(JSON.stringify({ totalUsage: 200 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/profile/user-1")) {
        return new Response(JSON.stringify({ displayName: "測試員", pictureUrl: "" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 200 });
    });

    const runId = crypto.randomUUID();
    await processLineAssistantQueueMessage({
      kind: "assistant",
      runId,
      assistantKey: "rueisiang-xiaoxiang",
      channelKey: "rueisiang-xiaoxiang",
      groupRowId: group.id,
      lineGroupId: "user-1",
      sourceType: "user",
      contextGeneration: group.contextResetAt ?? "",
      webhookEventId: "quota-full-event",
      replyToken: "expired-reply-token",
      questionText: "額度滿了嗎",
      replyDeadlineAt: Date.now() - 1,
    }, env as never);

    expect(requests.some((url) => url.endsWith("/message/push"))).toBe(false);
    const [delivery] = await db().select().from(assistantLinePushDeliveries).where(eq(assistantLinePushDeliveries.runId, runId));
    expect(delivery).toMatchObject({ status: "skipped", reason: "monthly_fixed_window_limit", remoteUsage: 200 });
    const [backup] = await db().select().from(assistantLineReplyBackups).where(eq(assistantLineReplyBackups.runId, runId));
    expect(backup?.responseText).toBe("額度滿時保留的回答");
  });

  it("不同計費月份使用不同 fixed window，同一 run 重試不重複預約", async () => {
    const group = await enableLineConversation(userEvent({ webhookEventId: "window-seed" }));
    const common = {
      channelKey: "rueisiang-xiaoxiang",
      groupId: group.id,
      lineGroupId: "user-1",
      sourceType: "user" as const,
      remoteUsage: 199,
      recipients: 1,
      limit: 200,
    };
    const runId = crypto.randomUUID();
    const first = await reserveAssistantLinePushDelivery(db(), { ...common, runId, windowKey: "2026-08" });
    const retry = await reserveAssistantLinePushDelivery(db(), { ...common, runId, windowKey: "2026-08" });
    const staleRemoteUsage = await reserveAssistantLinePushDelivery(db(), {
      ...common,
      runId: crypto.randomUUID(),
      windowKey: "2026-08",
    });
    const nextMonth = await reserveAssistantLinePushDelivery(db(), {
      ...common,
      runId: crypto.randomUUID(),
      windowKey: "2026-09",
      remoteUsage: 0,
    });

    expect(first.allowed).toBe(true);
    expect(retry.delivery.id).toBe(first.delivery.id);
    expect(staleRemoteUsage.allowed).toBe(false);
    expect(nextMonth.allowed).toBe(true);
    expect(await db().select().from(assistantLinePushDeliveries)).toHaveLength(3);
  });

  it("Push 遇到 5xx 時保留 reserved ledger 並交給 Queue retry", async () => {
    const group = await enableLineConversation(userEvent({ webhookEventId: "push-retry-seed" }));
    let pushAttempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: "應該重試的完整回答" }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/message/quota/consumption")) {
        return new Response(JSON.stringify({ totalUsage: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/profile/user-1")) {
        return new Response(JSON.stringify({ displayName: "測試員", pictureUrl: "" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/message/push")) {
        pushAttempts += 1;
        return pushAttempts === 1
          ? new Response("temporarily unavailable", { status: 503 })
          : new Response(null, { status: 200 });
      }
      return new Response(null, { status: 200 });
    });

    const runId = crypto.randomUUID();
    await expect(processLineAssistantQueueMessage({
      kind: "assistant",
      runId,
      assistantKey: "rueisiang-xiaoxiang",
      channelKey: "rueisiang-xiaoxiang",
      groupRowId: group.id,
      lineGroupId: "user-1",
      sourceType: "user",
      webhookEventId: "push-retry-event",
      replyToken: "expired-reply-token",
      questionText: "請重試 Push",
      replyDeadlineAt: Date.now() - 1,
    }, env as never)).rejects.toMatchObject({ endpoint: "push", retryable: true });

    const [delivery] = await db().select().from(assistantLinePushDeliveries).where(eq(assistantLinePushDeliveries.runId, runId));
    expect(delivery).toMatchObject({ status: "reserved", remoteUsage: 0 });

    // 第二次 Queue delivery 使用同一份 backup；成功後 run audit 必須從 failed 更新為 success，
    // 並保留第一次 Gemini 寫入的 usage，而不是被 backup 的空 usage 蓋成 0。
    await processLineAssistantQueueMessage({
      kind: "assistant",
      runId,
      assistantKey: "rueisiang-xiaoxiang",
      channelKey: "rueisiang-xiaoxiang",
      groupRowId: group.id,
      lineGroupId: "user-1",
      sourceType: "user",
      webhookEventId: "push-retry-event",
      replyToken: "expired-reply-token",
      questionText: "請重試 Push",
      replyDeadlineAt: Date.now() - 1,
    }, env as never);

    const [sentDelivery] = await db().select().from(assistantLinePushDeliveries).where(eq(assistantLinePushDeliveries.runId, runId));
    const [run] = await db().select().from(assistantRuns).where(eq(assistantRuns.id, runId));
    expect(sentDelivery?.status).toBe("sent");
    expect(run).toMatchObject({ status: "success", promptTokens: 1, candidateTokens: 2, totalTokens: 3 });
    expect(pushAttempts).toBe(2);
  });
});
