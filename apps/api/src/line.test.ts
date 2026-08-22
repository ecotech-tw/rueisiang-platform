import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import {
  ASSISTANT_LINE_QUEUE_MAX_ATTEMPTS,
  claimAssistantLineQueueJob,
  createDatabase,
  listPendingAssistantLineQueueJobs,
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
  assistantToolCalls,
  userRoles,
  users,
} from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";
import { lineQuestionText } from "./line.js";
import type { PiLineAgentRunRequest, PiLineAgentRunResponse } from "./pi-agent-contract.js";
import { processLineAssistantQueueMessage } from "./routes/webhooks.js";

const AUTH_SECRET = "line-test-auth-secret";
let d1: LocalD1;
let env: Record<string, unknown>;
let piAgentRequests: Array<{ agentName: string; path: string; payload: Record<string, unknown> }>;
let piAgentResponse: PiLineAgentRunResponse;
let piAgentError: string | undefined;
let piAgentStatus = 503;

function setPiAgentResponse(text: string, usage = { promptTokens: 1, candidateTokens: 2, totalTokens: 3 }): void {
  piAgentResponse = {
    sessionId: "test-session",
    model: "gpt-5.4-mini",
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
        if (piAgentError) return Response.json({ error: piAgentError }, { status: piAgentStatus });
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
  await db().insert(users).values({ id: "admin", email: "admin@ecotech.tw", name: "管理者", status: "active" });
  await db().insert(userRoles).values({ userId: "admin", roleId: "role-admin" });
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
      model: "gpt-5.4-mini",
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
    expect(runs[0]).toMatchObject({ channel: "line", groupId: "group-1", model: "gpt-5.4-mini", status: "success", totalTokens: 18 });
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
    expect(runs[0]).toMatchObject({ status: "failed", model: "gpt-5.4-mini" });
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
