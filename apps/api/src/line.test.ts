import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { assistantConfigs, assistantLineChannels, assistantLineGroups, assistantLineMessages, assistantRuns, userRoles, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";
import { lineQuestionText } from "./line.js";

const AUTH_SECRET = "line-test-auth-secret";
let d1: LocalD1;
let env: Record<string, unknown>;

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
    timestamp: 1787294000000,
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

beforeEach(async () => {
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: AUTH_SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    LINE_CHANNEL_SECRET: "line-secret",
  };
  await syncSystemRoles(db());
  await seedAdmin();
});

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

  it("只記錄群組中真正 mention 小香的文字事件", async () => {
    const body = JSON.stringify({ events: [
      mentionEvent(),
      { ...mentionEvent({ webhookEventId: "evt-2" }), message: { type: "text", text: "一般聊天" } },
      { ...mentionEvent({ webhookEventId: "evt-3" }), source: { type: "user", userId: "user-1" } },
    ] });
    const response = await postLine(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "accepted", recorded: 1, ignored: 2 });

    const [group] = await db().select().from(assistantLineGroups);
    const [message] = await db().select().from(assistantLineMessages);
    expect(group).toMatchObject({ lineGroupId: "group-1", enabled: false });
    expect(message).toMatchObject({ lineGroupId: "group-1", text: "@Rueisiang 小香 請幫我查一下", sourceType: "group" });
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

  it("已開通的群組會使用 active model 與 prompt 回覆，並記錄 LINE 用量", async () => {
    const firstBody = JSON.stringify({ events: [mentionEvent()] });
    await postLine(firstBody);
    await db().update(assistantLineChannels).set({ enabled: true }).where(eq(assistantLineChannels.assistantKey, "rueisiang-xiaoxiang"));
    const [group] = await db().select().from(assistantLineGroups).where(eq(assistantLineGroups.lineGroupId, "group-1"));
    await db().update(assistantLineGroups).set({ enabled: true }).where(eq(assistantLineGroups.id, group!.id));

    await call("/api/assistant/line/config", {
      method: "PATCH",
      body: JSON.stringify({ channelId: "2001234567", channelSecret: "line-secret", accessToken: "access-token-from-portal", displayName: "Rueisiang 小香", enabled: true }),
    });
    env = { ...env, GEMINI_API_KEY: "gemini-test-key", LINE_CHANNEL_ACCESS_TOKEN: "wrong-env-token" };
    const requests: Array<{ url: string; body: string; authorization: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        body: typeof init?.body === "string" ? init.body : "",
        authorization: new Headers(init?.headers).get("authorization") ?? "",
      });
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [
            { text: "這是 LINE 不應收到的 thought summary", thought: true },
            { text: "已收到，我會依照群組內容協助處理。" },
          ] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8, totalTokenCount: 18 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 200 });
    });

    const response = await postLine(JSON.stringify({ events: [mentionEvent({ webhookEventId: "evt-2", replyToken: "reply-token-2" })] }));
    expect(response.status).toBe(200);
    // 群組還沒有名字，所以收到訊息時會先去補一次名稱與大頭貼，再跑回覆流程。
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.line.me/v2/bot/group/group-1/summary",
      expect.stringContaining("generativelanguage.googleapis.com"),
      "https://api.line.me/v2/bot/message/push",
    ]);
    const geminiRequest = requests.find((request) => request.url.includes("generativelanguage.googleapis.com"));
    expect(geminiRequest?.body).toContain("請幫我查一下");
    const pushRequest = requests.find((request) => request.url.endsWith("/message/push"));
    expect(pushRequest?.authorization).toBe("Bearer access-token-from-portal");
    expect(pushRequest?.body).toContain("已收到，我會依照群組內容協助處理。");
    expect(pushRequest?.body).not.toContain("LINE 不應收到的 thought summary");
    const runs = await db().select().from(assistantRuns).where(eq(assistantRuns.channel, "line"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ channel: "line", groupId: "group-1", model: "gemini-3.6-flash", status: "success", totalTokens: 18 });
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
    await call("/api/assistant/sandbox/config");
    await db().update(assistantConfigs).set({ activeModel: "gemini-2.5-flash" }).where(eq(assistantConfigs.assistantKey, "rueisiang-xiaoxiang"));
    env = { ...env, GEMINI_API_KEY: "gemini-test-key" };

    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      requests.push(String(input));
      return new Response(null, { status: 200 });
    });
    const response = await postLine(JSON.stringify({ events: [mentionEvent({ webhookEventId: "evt-invalid-config", replyToken: "reply-invalid" })] }));
    expect(response.status).toBe(200);
    expect(requests).toEqual([
      "https://api.line.me/v2/bot/group/group-1/summary",
      "https://api.line.me/v2/bot/message/push",
    ]);
    const runs = await db().select().from(assistantRuns).where(eq(assistantRuns.channel, "line"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", model: "gemini-2.5-flash" });
  });
});
