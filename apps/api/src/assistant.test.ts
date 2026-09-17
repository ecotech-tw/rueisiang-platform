import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { ASSISTANT_REPORT_TOOL_ROUTING } from "@rueisiang/assistant";
import { CRM_SEARCH_CUSTOMERS_TOOL_KEY, PLATFORM_TOOL_MAP } from "@rueisiang/tools";
import { appendAssistantSandboxMessage, createDatabase, syncSystemRoles, updateAssistantSandboxContext } from "@rueisiang/db";
import {
  activityEvents,
  assistantConfigs,
  assistantLineChannels,
  assistantLineGroups,
  assistantLineMessages,
  assistantSandboxMessages,
  crmCustomerTags,
  crmTags,
  crmCustomers,
  itemCategories,
  items,
  reportItemSalesMonthly,
  reportPayoutDaily,
  reportRuns,
  scopes,
  wmsItems,
  wmsLayoutElements,
  wmsLayouts,
  mediaObjects,
  rolePermissionGrants,
  roles,
  userRoleAssignments,
  users,
} from "@rueisiang/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { PLATFORM_TOOL_DEFINITIONS } from "@rueisiang/tools";
import app from "./index.js";
import { createCyberbizReportService } from "./cyberbiz-reports.js";
import { AssistantChatAgent } from "./pi-agent-do.js";
import { createLocalD1, createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "assistant-test-secret";
const CODEX_ACCESS_TOKEN = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
})).toString("base64url")}.test-signature`;
let d1: LocalD1;
let env: Record<string, unknown>;
let assistantAgents: TestAssistantAgentNamespace | undefined;

function asGeminiStream(body: Record<string, unknown>): Response {
  const candidates = Array.isArray(body.candidates)
    ? body.candidates.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || "finishReason" in candidate) return candidate;
      return { ...candidate, finishReason: "STOP" };
    })
    : body.candidates;
  return new Response(`data: ${JSON.stringify({ ...body, candidates })}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function asCodexStream(body: Record<string, unknown>): Response {
  const candidate = Array.isArray(body.candidates) && body.candidates[0] && typeof body.candidates[0] === "object"
    ? body.candidates[0] as Record<string, unknown>
    : undefined;
  const content = candidate?.content && typeof candidate.content === "object"
    ? candidate.content as Record<string, unknown>
    : undefined;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const events: Record<string, unknown>[] = [
    { type: "response.created", response: { id: "resp-test", status: "in_progress" } },
  ];
  const output: Record<string, unknown>[] = [];
  let outputIndex = 0;
  for (const rawPart of parts) {
    if (!rawPart || typeof rawPart !== "object") continue;
    const part = rawPart as Record<string, unknown>;
    const index = outputIndex++;
    if (part.thought === true && typeof part.text === "string") {
      const id = `rs-test-${index}`;
      events.push({
        type: "response.output_item.added",
        output_index: index,
        item: { type: "reasoning", id, summary: [], content: [] },
      });
      events.push({ type: "response.reasoning_summary_text.delta", output_index: index, delta: part.text });
      const item = { type: "reasoning", id, summary: [{ type: "summary_text", text: part.text }], content: [] };
      events.push({ type: "response.output_item.done", output_index: index, item });
      output.push(item);
      continue;
    }
    if (part.functionCall && typeof part.functionCall === "object") {
      const functionCall = part.functionCall as Record<string, unknown>;
      const id = typeof functionCall.id === "string" ? functionCall.id : `fc-test-${index}`;
      const callId = typeof functionCall.callId === "string" ? functionCall.callId : id;
      const name = typeof functionCall.name === "string" ? functionCall.name : "unknown_tool";
      const args = functionCall.args && typeof functionCall.args === "object" ? JSON.stringify(functionCall.args) : "{}";
      const added = { type: "function_call", id, call_id: callId, name, arguments: "" };
      events.push({ type: "response.output_item.added", output_index: index, item: added });
      events.push({ type: "response.function_call_arguments.delta", output_index: index, delta: args });
      events.push({ type: "response.function_call_arguments.done", output_index: index, arguments: args });
      const item = { ...added, arguments: args };
      events.push({ type: "response.output_item.done", output_index: index, item });
      output.push(item);
      continue;
    }
    if (typeof part.text === "string") {
      const id = `msg-test-${index}`;
      events.push({
        type: "response.output_item.added",
        output_index: index,
        item: { type: "message", id, role: "assistant", content: [], phase: "final_answer" },
      });
      events.push({ type: "response.output_text.delta", output_index: index, delta: part.text });
      const item = {
        type: "message",
        id,
        role: "assistant",
        content: [{ type: "output_text", text: part.text, annotations: [] }],
        phase: "final_answer",
      };
      events.push({ type: "response.output_item.done", output_index: index, item });
      output.push(item);
    }
  }
  const usageMetadata = body.usageMetadata && typeof body.usageMetadata === "object"
    ? body.usageMetadata as Record<string, unknown>
    : {};
  events.push({
    type: "response.completed",
    response: {
      id: "resp-test",
      status: "completed",
      output,
      usage: {
        input_tokens: usageMetadata.promptTokenCount ?? 0,
        output_tokens: usageMetadata.candidatesTokenCount ?? 0,
        total_tokens: usageMetadata.totalTokenCount ?? 0,
        input_tokens_details: { cached_tokens: 0 },
      },
    },
  });
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** 讓 Node route test 跑真正的 Pi Agent DO；每個 instance 各有自己的 SQLite transcript。 */
class TestAssistantAgentNamespace {
  private readonly agents = new Map<string, {
    agent: AssistantChatAgent;
    sqlite: DatabaseSync;
    alarm: { scheduled: boolean };
  }>();

  constructor(private readonly currentEnv: () => Record<string, unknown>) {}

  getByName(name: string) {
    let entry = this.agents.get(name);
    if (!entry) {
      const sqlite = new DatabaseSync(":memory:");
      const alarm = { scheduled: false };
      const sql = {
        exec: (query: string, ...bindings: unknown[]) => {
          if (!bindings.length && query.includes(";")) {
            sqlite.exec(query);
            return [];
          }
          return sqlite.prepare(query).all(...bindings as never[]);
        },
      };
      const storage = {
        sql,
        setAlarm: async () => {
          alarm.scheduled = true;
        },
        deleteAlarm: async () => {
          alarm.scheduled = false;
        },
      };
      const state = {
        storage,
        blockConcurrencyWhile: (initialize: () => Promise<void>) => {
          void initialize();
        },
      };
      entry = {
        agent: new AssistantChatAgent(state as never, this.currentEnv() as never),
        sqlite,
        alarm,
      };
      this.agents.set(name, entry);
    }
    return {
      fetch: async (request: Request) => {
        const mockedFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const isCodexRequest = String(input).includes("/codex/responses");
          let forwardedInit = init;
          if (isCodexRequest) {
            const requestBodyText = typeof init?.body === "string"
              ? init.body
              : init?.body instanceof Uint8Array
                ? zstdDecompressSync(init.body).toString("utf8")
                : "";
            const requestBody = JSON.parse(requestBodyText) as Record<string, unknown>;
            forwardedInit = {
              ...init,
              body: JSON.stringify({
                ...requestBody,
                contents: requestBody.input,
                systemInstruction: requestBody.instructions,
              }),
            };
          }
          const response = await mockedFetch(input, forwardedInit);
          if (!response.ok || (!isCodexRequest && !String(input).includes("streamGenerateContent"))) return response;
          const payload = await response.clone().json().catch(() => null);
          if (!payload || typeof payload !== "object") return response;
          return isCodexRequest
            ? asCodexStream(payload as Record<string, unknown>)
            : asGeminiStream(payload as Record<string, unknown>);
        }) as typeof fetch;
        try {
          const response = await entry.agent.fetch(request);
          if (entry.alarm.scheduled) {
            entry.alarm.scheduled = false;
            await entry.agent.alarm();
          }
          return response;
        } finally {
          globalThis.fetch = mockedFetch;
        }
      },
    };
  }

  seedLegacyCompactionState(name: string, model: string): void {
    const entry = this.agents.get(name);
    if (!entry) throw new Error(`找不到測試中的 assistant agent：${name}`);
    const state = entry.sqlite.prepare(
      "SELECT generation FROM assistant_agent_state WHERE singleton = 1 LIMIT 1",
    ).get() as { generation: string } | undefined;
    if (!state) throw new Error("測試 assistant agent 尚未建立 state。");
    entry.sqlite.prepare(
      "UPDATE assistant_agent_state SET model = ? WHERE singleton = 1",
    ).run(model);
    const runId = `legacy-compaction:${state.generation}`;
    entry.sqlite.prepare(
      `INSERT OR IGNORE INTO assistant_agent_runs (run_id, generation, status, response_json, updated_at)
       VALUES (?, ?, 'completed', '', ?)`,
    ).run(runId, state.generation, Date.now());
    const insert = entry.sqlite.prepare(
      `INSERT INTO assistant_agent_messages (generation, run_id, role, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 24; index += 1) {
      const timestamp = Date.now() + index;
      insert.run(
        state.generation,
        runId,
        "user",
        JSON.stringify({ role: "user", content: `legacy user ${index} ${"歷史".repeat(2_500)}`, timestamp }),
        timestamp,
      );
      insert.run(
        state.generation,
        runId,
        "assistant",
        JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: `legacy assistant ${index} ${"回答".repeat(2_500)}` }],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: timestamp + 1,
        }),
        timestamp + 1,
      );
    }
  }

  async alarm(name: string): Promise<void> {
    const entry = this.agents.get(name);
    if (!entry) throw new Error(`找不到測試中的 assistant agent：${name}`);
    await entry.agent.alarm();
  }

  model(name: string): string | undefined {
    const entry = this.agents.get(name);
    if (!entry) return undefined;
    return (entry.sqlite.prepare(
      "SELECT model FROM assistant_agent_state WHERE singleton = 1 LIMIT 1",
    ).get() as { model?: string } | undefined)?.model;
  }

  close(): void {
    for (const entry of this.agents.values()) entry.sqlite.close();
    this.agents.clear();
  }
}

function db() {
  return createDatabase(d1 as never);
}

describe("小香的客戶搜尋工具", () => {
  it("回傳整個資料庫的統計，不是這次篩選的結果", async () => {
    await db().insert(crmCustomers).values([
      { id: "tool-1", phone: "0911000001", normalizedPhone: "0911000001", name: "有資料的客戶", address: "台南市", status: "active" },
      { id: "tool-2", phone: "0911000002", normalizedPhone: "0911000002", name: "", address: "", status: "active" },
      { id: "tool-3", phone: "0911000003", normalizedPhone: "0911000003", name: "停權客戶", address: "高雄市", status: "blocked" },
    ]);

    const tool = PLATFORM_TOOL_MAP.get(CRM_SEARCH_CUSTOMERS_TOOL_KEY);
    const output = JSON.parse(await tool!.execute({ status: "blocked" }, { db: db() } as never) as string);

    // 篩選只影響 customers 與 total；stats 描述的是整個資料庫。
    expect(output.total).toBe(1);
    expect(output.stats).toEqual({ total: 3, active: 2, blocked: 1, incomplete: 1 });
  });
});

async function seedUser(id: string, email: string, roleId: string) {
  await db().insert(users).values({ id, email, googleName: email, status: "active" });
  await db().insert(userRoleAssignments).values({ userId: id, roleId });
}

async function cookieFor(id: string, email: string) {
  const token = await signSession(
    newSessionClaims({ id, email, name: "測試管理者", pictureUrl: "" }),
    SECRET,
  );
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

async function call(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`https://platform.rueisiang.com${path}`, init), env as never);
}

async function as(id: string, email: string, path: string, init: RequestInit = {}) {
  return call(path, {
    ...init,
    headers: { Cookie: await cookieFor(id, email), "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

beforeEach(async () => {
  assistantAgents?.close();
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    GEMINI_API_KEY: "test-key",
    CYBERBIZ_API_TOKEN: "cyberbiz-test-token",
  };
  assistantAgents = new TestAssistantAgentNamespace(() => env);
  env.ASSISTANT_CHAT_AGENT = assistantAgents;
  await syncSystemRoles(db());
  vi.restoreAllMocks();
});

/**
 * LINE 前台的權限是獨立的一組：只有 assistant:line:* 的人也要能把這一頁用完整。
 *
 * 這一段釘的是「工具目錄從哪裡來」。目錄一度是跟 /sandbox/config 借的，那支要
 * assistant:sandbox:read——只有 LINE 權限的人打不到，畫面會變成「一個工具都沒有」，
 * 看起來像設定錯誤，其實是權限擋住的假象。
 */
describe("只有 LINE 權限的人", () => {
  async function seedLineOnlyUser() {
    await db().insert(roles).values({ id: "role-line", roleKey: "line-only", name: "LINE 管理", isSystem: false });
    await db().insert(rolePermissionGrants).values([
      { roleId: "role-line", permission: "assistant:line:read" },
      { roleId: "role-line", permission: "assistant:line:write" },
    ]);
    await seedUser("line-user", "line@ecotech.tw", "role-line");
  }

  it("打不到 sandbox 設定，但拿得到 LINE 設定與工具目錄", async () => {
    await seedLineOnlyUser();

    expect((await as("line-user", "line@ecotech.tw", "/api/assistant/sandbox/config")).status).toBe(403);

    const response = await as("line-user", "line@ecotech.tw", "/api/assistant/line/config");
    expect(response.status).toBe(200);
    const body = await response.json() as { tools: Array<{ key: string; surfaces: string[] }>; channelTools: string[] };
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools.every((tool) => tool.surfaces.includes("line"))).toBe(true);
    expect(body.channelTools.sort()).toEqual([
      "crm_get_customer",
      "crm_get_orders",
      "crm_search_customers",
      "list_items",
      "list_report_scopes",
      "query_payout_report",
      "query_sales_report",
      "weather_open_meteo",
      "wms_get_activity",
      "wms_get_inventory_item",
      "wms_list_inventory",
      "wms_list_low_stock_items",
      "wms_search_warehouse",
    ]);
  });

  it("資料庫裡殘留的未知 channel tool 不會被回報成已授權", async () => {
    await seedLineOnlyUser();
    // 先讓 channel 存在，才能掛殘留資料上去；新 channel 預設會取得全部 LINE 工具。
    await as("line-user", "line@ecotech.tw", "/api/assistant/line/config");

    /*
     * 模擬資料庫裡殘留一個已不在 registry 的舊工具。設定頁仍只回報目前支援 LINE 的工具，
     * 但新加入的 CRM 工具應該正常出現在 channel 白名單裡。
     */
    const channelKey = "rueisiang-xiaoxiang";
    d1.sqlite.exec(`
      INSERT INTO assistant_channel_tools (id, channel_key, tool_key, created_by)
      VALUES ('stale-1', '${channelKey}', 'legacy_sandbox_tool', 'test');
    `);

    const response = await as("line-user", "line@ecotech.tw", "/api/assistant/line/config");
    const body = await response.json() as { tools: Array<{ key: string }>; channelTools: string[] };

    expect(body.tools.map((tool) => tool.key)).not.toContain("legacy_sandbox_tool");
    expect(body.channelTools).not.toContain("legacy_sandbox_tool");
    expect(body.channelTools).toContain("crm_get_customer");
  });
});

describe("LINE 群組的開通開關", () => {
  async function seedAdminAndGroup() {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    // 建立 channel，然後模擬 webhook 發現一個新群組——名稱預設是空字串。
    await as("admin", "admin@ecotech.tw", "/api/assistant/line/config");
    const created = await as("admin", "admin@ecotech.tw", "/api/assistant/line/groups", {
      method: "POST",
      body: JSON.stringify({ lineGroupId: "Cabc123" }),
    });
    const body = await created.json() as { group: { id: string; displayName: string } };
    expect(body.group.displayName).toBe("");
    return body.group.id;
  }

  /*
   * 切開關卻被要求先命名，是沒有道理的。畫面上的開關只送 enabled，這裡釘住後端在
   * displayName 省略時要維持原值，而不是把空字串當成「沒填」退回。
   */
  it("沒有名稱的群組也能直接開通", async () => {
    const id = await seedAdminAndGroup();

    const response = await as("admin", "admin@ecotech.tw", `/api/assistant/line/groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { group: { enabled: boolean; displayName: string } };
    expect(body.group.enabled).toBe(true);
    expect(body.group.displayName).toBe("");
  });

  it("真的要改名時，空字串仍然擋下來", async () => {
    const id = await seedAdminAndGroup();
    const response = await as("admin", "admin@ecotech.tw", `/api/assistant/line/groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "", enabled: true }),
    });
    expect(response.status).toBe(400);
  });
});

describe("AI 助理 Sandbox", () => {
  it("需要登入與 Sandbox 權限", async () => {
    expect((await call("/api/assistant/sandbox/config")).status).toBe(401);

    await seedUser("staff", "staff@ecotech.tw", "role-staff");
    expect((await as("staff", "staff@ecotech.tw", "/api/assistant/sandbox/config")).status).toBe(403);
  });

  it("回傳模型、tool 與預設 prompt", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config");
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      configured: boolean;
      activeModel: string;
      models: Array<{ id: string; provider: string; configured: boolean }>;
      tools: Array<{ key: string; status: string }>;
      activePrompt: { revision: number; isActive: boolean };
    };
    expect(result.configured).toBe(true);
    expect(result.activeModel).toBe("gpt-5.4-mini");
    expect(result.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-5.4-mini", provider: "openai-codex", configured: false }),
      expect.objectContaining({ id: "gemini-3.6-flash", provider: "google", configured: true }),
    ]));
    expect(result.tools.map((tool) => tool.key)).toEqual([
      "weather_open_meteo",
      "list_items",
      "wms_list_inventory",
      "wms_search_warehouse",
      "wms_get_inventory_item",
      "wms_list_low_stock_items",
      "wms_get_activity",
      "crm_search_customers",
      "crm_get_customer",
      "crm_get_orders",
      "list_report_scopes",
      "query_sales_report",
      "query_payout_report",
    ]);
    expect(result.tools.find((tool) => tool.key === "wms_search_warehouse")).toMatchObject({
      label: "WMS 搜尋倉庫位置",
      status: "enabled",
      surfaces: ["sandbox", "line", "mcp"],
      requiredPermissions: ["wms:inventory:read", "wms:map:read"],
    });
    expect(result.tools.find((tool) => tool.key === "crm_search_customers")).toMatchObject({
      label: "CRM 搜尋客戶",
      status: "enabled",
      surfaces: ["sandbox", "line", "mcp"],
      requiredPermissions: ["crm:customer:read"],
    });
    expect(result.tools.find((tool) => tool.key === "crm_get_orders")).toMatchObject({
      status: "enabled",
      surfaces: ["sandbox", "line", "mcp"],
      requiredPermissions: ["crm:order:read"],
    });
    expect(result.activePrompt).toMatchObject({ revision: 1, isActive: true });
  });

  it("Sandbox 圖片會把 bytes 放在 NAS、metadata 留在 D1，並受使用者權限保護", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const config = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config")).json() as { activePrompt: { id: string } };
    const created = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id }),
    })).json() as { session: { id: string } };
    env.NAS_STORAGE_URL = "https://storage.test";
    env.NAS_STORAGE_TOKEN = "nas-secret";
    const objects = new Map<string, Uint8Array>();
    let uploadNumber = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("x-storage-token")).toBe("nas-secret");
      const method = init?.method ?? "GET";
      if (method === "POST") {
        expect(url.searchParams.get("namespace")).toBe("assistant");
        expect(url.searchParams.get("scope")).toBe("vision");
        expect(url.searchParams.get("scopeId")).toBe(created.session.id);
        const bytes = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        const key = `assistant/vision/${created.session.id}/2026/08/00000000-0000-0000-0000-${String(++uploadNumber).padStart(12, "0")}.png`;
        objects.set(key, bytes);
        return new Response(JSON.stringify({
          object: { key, size: bytes.byteLength, checksum: "0".repeat(64), contentType: "image/png" },
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      const key = url.searchParams.get("key") ?? "";
      if (method === "GET") {
        const bytes = objects.get(key);
        return bytes
          ? new Response(bytes, { status: 200, headers: { "content-type": "image/png" } })
          : new Response(null, { status: 404 });
      }
      return new Response(null, { status: 405 });
    });
    vi.stubGlobal("fetch", fetcher);

    try {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const form = new FormData();
      form.append("file", new File([bytes as never], "label.png", { type: "image/png" }));
      form.append("chatId", created.session.id);
      const uploaded = await call("/api/assistant/sandbox/attachments", {
        method: "POST",
        headers: { Cookie: await cookieFor("admin", "admin@ecotech.tw") },
        body: form,
      });
      expect(uploaded.status).toBe(201);
      const body = await uploaded.json() as { attachment: { key: string; expiresAt: string } };
      expect(body.attachment.key).toMatch(new RegExp(`^assistant/vision/${created.session.id}/2026/08/`));
      expect(body.attachment.expiresAt).toBeTruthy();
      expect(objects.get(body.attachment.key)).toEqual(bytes);

      const [media] = await db().select().from(mediaObjects);
      expect(media).toMatchObject({
        objectKey: body.attachment.key,
        namespace: "assistant",
        scopeKey: `sandbox:${created.session.id}`,
        contentType: "image/png",
        size: bytes.byteLength,
      });

      const downloaded = await call(`/api/assistant/sandbox/attachments?key=${encodeURIComponent(body.attachment.key)}`, {
        headers: { Cookie: await cookieFor("admin", "admin@ecotech.tw") },
      });
      expect(downloaded.status).toBe(200);
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Pi catalog 有但 Sandbox 清單沒有的模型會回落到可執行的 Codex 預設值", async () => {
    env.PI_AGENT_MODEL = "gemini-flash-latest";
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    await db().insert(assistantConfigs).values({
      assistantKey: "rueisiang-xiaoxiang",
      activeModel: "gemini-flash-latest",
      updatedBy: "test",
      updatedAt: new Date().toISOString(),
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config");
    expect(response.status).toBe(200);
    const result = await response.json() as {
      defaultModel: string;
      activeModel: string;
      models: Array<{ id: string }>;
    };
    expect(result.defaultModel).toBe("gpt-5.4-mini");
    expect(result.activeModel).toBe("gpt-5.4-mini");
    expect(result.models.some((model) => model.id === "gemini-flash-latest")).toBe(false);
  });

  it("GPT Sandbox 需要 Codex OAuth，設定後會 dispatch 到同一個 Pi Agent", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");

    const credentialVault = env.ASSISTANT_CREDENTIAL_VAULT;
    env.ASSISTANT_CREDENTIAL_VAULT = undefined;
    const unavailable = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.4-mini", toolKeys: [], input: "測試 Codex" }),
    });
    expect(unavailable.status).toBe(503);
    env.ASSISTANT_CREDENTIAL_VAULT = credentialVault;

    let dispatchedName = "";
    let dispatchedBody: Record<string, unknown> | undefined;
    env.ASSISTANT_CREDENTIAL_VAULT = {
      getByName: () => ({
        fetch: async () => Response.json({ configured: true }),
      }),
    };
    env.ASSISTANT_CHAT_AGENT = {
      getByName: (name: string) => ({
        fetch: async (request: Request) => {
          dispatchedName = name;
          dispatchedBody = await request.json() as Record<string, unknown>;
          return Response.json({
            sessionId: "pi-sandbox-session",
            model: "gpt-5.4-mini",
            result: {
              text: "Codex 已透過 Pi 回覆。",
              thoughts: "",
              usage: { promptTokens: 3, candidateTokens: 2, totalTokens: 5 },
              toolCalls: [],
            },
          });
        },
      }),
    };

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.4-mini", toolKeys: [], input: "測試 Codex" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      model: "gpt-5.4-mini",
      text: "Codex 已透過 Pi 回覆。",
    });
    expect(dispatchedName).toMatch(/^rueisiang-xiaoxiang:sandbox:admin:/u);
    expect(dispatchedBody).toMatchObject({
      assistantKey: "rueisiang-xiaoxiang",
      actorUserId: "admin",
      model: "gpt-5.4-mini",
      userText: "測試 Codex",
    });
  });

  it("LINE Pi Agent 首次使用會回填既有 D1 訊息，且排除目前 webhook", async () => {
    await db().insert(assistantLineChannels).values({
      channelKey: "rueisiang-xiaoxiang",
      assistantKey: "rueisiang-xiaoxiang",
      updatedBy: "test",
      enabled: true,
    });
    await db().insert(assistantLineGroups).values({
      id: "line-group-1",
      channelKey: "rueisiang-xiaoxiang",
      lineGroupId: "line-user-1",
      sourceType: "user",
      enabled: true,
    });
    await db().insert(assistantLineMessages).values([
      {
        id: "line-history-1",
        channelKey: "rueisiang-xiaoxiang",
        lineGroupId: "line-user-1",
        sourceType: "user",
        webhookEventId: "old-event",
        text: "之前的問題",
        createdAt: "2026-08-22T10:00:00.000Z",
      },
      {
        id: "line-current-1",
        channelKey: "rueisiang-xiaoxiang",
        lineGroupId: "line-user-1",
        sourceType: "user",
        webhookEventId: "current-event",
        text: "這次問題",
        createdAt: "2026-08-22T10:01:00.000Z",
      },
    ]);

    let requestBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "LINE 回答" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const agent = assistantAgents!.getByName("rueisiang-xiaoxiang:rueisiang-xiaoxiang:user:line-user-1");
    const response = await agent.fetch(new Request("https://assistant-agent.internal/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assistantKey: "rueisiang-xiaoxiang",
        channelKey: "rueisiang-xiaoxiang",
        groupRowId: "line-group-1",
        lineGroupId: "line-user-1",
        sourceType: "user",
        contextGeneration: "",
        webhookEventId: "current-event",
        runId: "line-bootstrap-run",
        model: "gemini-3.6-flash",
        systemPrompt: "你是 LINE 助理。",
        userText: "這次問題",
        toolKeys: [],
      }),
    }));

    expect(response.status).toBe(200);
    const contents = JSON.stringify(requestBody?.contents);
    expect(contents).toContain("之前的問題");
    expect(contents.match(/這次問題/g)).toHaveLength(1);
  });

  it("Sandbox bootstrap 會略過既有摘要涵蓋的訊息，並由背景 compact 不阻塞主回答", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const config = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config")).json() as { activePrompt: { id: string } };
    const created = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id }),
    })).json() as { session: { id: string } };
    const messages = Array.from({ length: 40 }, (_, index) => [
      {
        id: `sandbox-bootstrap-user-${index}`,
        sessionId: created.session.id,
        role: "user" as const,
        text: index < 10 ? `covered-history-${index}` : `imported-history-${index} ${"歷史".repeat(3_000)}`,
        createdAt: new Date(Date.UTC(2026, 7, 22, 10, index, 0)).toISOString(),
      },
      {
        id: `sandbox-bootstrap-model-${index}`,
        sessionId: created.session.id,
        role: "model" as const,
        text: index < 10 ? `covered-answer-${index}` : `imported-answer-${index} ${"回答".repeat(3_000)}`,
        model: "gemini-3.6-flash",
        createdAt: new Date(Date.UTC(2026, 7, 22, 10, index, 30)).toISOString(),
      },
    ]).flat();
    await db().insert(assistantSandboxMessages).values(messages);
    await updateAssistantSandboxContext(db(), {
      assistantKey: "rueisiang-xiaoxiang",
      createdBy: "admin",
      id: created.session.id,
      contextSummary: "legacy summary",
      contextSummaryMessageCount: 20,
    });

    const requests: Array<{ body: Record<string, unknown>; summary: boolean }> = [];
    let mainCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const summary = JSON.stringify(body.systemInstruction).includes("context summarization assistant");
      requests.push({ body, summary });
      const text = summary ? "imported history compacted" : "Sandbox bootstrap 回答 " + ++mainCount;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokens: 15 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        sessionId: created.session.id,
        model: "gemini-3.6-flash",
        promptRevisionId: config.activePrompt.id,
        toolKeys: [],
        input: "目前問題",
      }),
    });
    expect(response.status).toBe(200);
    const mainIndex = requests.findIndex((request) => !request.summary);
    const summaryIndex = requests.findIndex((request) => request.summary);
    expect(mainIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeGreaterThan(mainIndex);
    const mainRequest = requests[mainIndex];
    const contents = JSON.stringify(mainRequest?.body.contents);
    expect(contents).toContain("legacy summary");
    expect(contents).toContain("imported-history-39");
    expect(contents).not.toContain("imported history compacted");
    expect(contents).not.toContain("covered-history-0");
    expect(contents).not.toContain("covered-answer-0");
  });

  it("儲存 prompt 時建立 revision 並立即啟用", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/prompts", {
      method: "POST",
      body: JSON.stringify({ systemPrompt: "你是新的測試 prompt。" }),
    });
    expect(response.status).toBe(201);

    const config = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config");
    const result = (await config.json()) as { activePrompt: { revision: number; systemPrompt: string; isActive: boolean } };
    expect(result.activePrompt).toMatchObject({ revision: 2, systemPrompt: "你是新的測試 prompt。", isActive: true });
  });

  it("儲存 active model 後，小香的後續執行會使用新模型", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const saved = await as("admin", "admin@ecotech.tw", "/api/assistant/config", {
      method: "PATCH",
      body: JSON.stringify({ model: "gemini-3.1-flash-lite" }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ activeModel: "gemini-3.1-flash-lite" });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "已使用新模型。" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ toolKeys: [], input: "測試 active model" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: "gemini-3.1-flash-lite", text: "已使用新模型。" });
  });

  it("可以設定任意 fallback model，Gemini 失敗時改用 GPT 完成同一輪", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    env.ASSISTANT_CREDENTIAL_VAULT = {
      getByName: () => ({
        fetch: async (request: Request) => request.url.endsWith("/status")
          ? Response.json({ configured: true, status: "ready", lastErrorAt: null })
          : Response.json({ accessToken: CODEX_ACCESS_TOKEN }),
      }),
    };

    const saved = await as("admin", "admin@ecotech.tw", "/api/assistant/config", {
      method: "PATCH",
      body: JSON.stringify({ model: "gemini-3.6-flash", fallbackModel: "gpt-5.4-mini" }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      activeModel: "gemini-3.6-flash",
      fallbackModel: "gpt-5.4-mini",
    });

    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("generativelanguage")) {
        return new Response(JSON.stringify({ error: { message: "Gemini temporary outage" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/codex/responses")) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: "GPT fallback 回覆" }] } }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: "unexpected provider" } }), { status: 500 });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", toolKeys: [], input: "測試模型 fallback" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      model: "gpt-5.4-mini",
      text: "GPT fallback 回覆",
    });
    expect(requests.some((url) => url.includes("generativelanguage"))).toBe(true);
    expect(requests.some((url) => url.includes("/codex/responses"))).toBe(true);
  });

  it("只有具備設定權限的人可以匯入 Codex credential，而且回應不包含原文", async () => {
    await seedUser("staff", "staff@ecotech.tw", "role-staff");
    const forbidden = await as("staff", "staff@ecotech.tw", "/api/assistant/codex-credential", {
      method: "POST",
      body: JSON.stringify({ credential: "{}" }),
    });
    expect(forbidden.status).toBe(403);

    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const credential = JSON.stringify({
      "openai-codex": {
        access: "access-imported",
        refresh: "refresh-imported",
        expires: Date.now() + 3_600_000,
      },
    });
    let receivedCredential = "";
    env.ASSISTANT_CREDENTIAL_VAULT = {
      getByName: () => ({
        fetch: async (request: Request) => {
          if (request.url.endsWith("/credential")) {
            const payload = await request.json() as { credential?: unknown };
            receivedCredential = typeof payload.credential === "string" ? payload.credential : "";
            return Response.json({ configured: true, status: "ready", lastErrorAt: null });
          }
          return Response.json({ configured: true, status: "ready", lastErrorAt: null });
        },
      }),
    };

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/codex-credential", {
      method: "POST",
      body: JSON.stringify({ credential }),
    });
    expect(response.status).toBe(200);
    expect(receivedCredential).toBe(credential);
    expect(JSON.stringify(await response.json())).not.toContain("refresh-imported");
  });

  it("可以從小香設定更新 tool 狀態", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/tools/weather_open_meteo", {
      method: "PATCH",
      body: JSON.stringify({ status: "enabled" }),
    });
    expect(response.status).toBe(200);

    const config = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config");
    const result = (await config.json()) as { tools: Array<{ key: string; status: string }> };
    expect(result.tools.find((tool) => tool.key === "weather_open_meteo")).toMatchObject({
      key: "weather_open_meteo",
      label: "Open-Meteo 天氣查詢",
      status: "enabled",
    });
  });

  it("報表語意會把業績導向 payout、商品銷售導向 sales", () => {
    expect(ASSISTANT_REPORT_TOOL_ROUTING).toContain("業績、總業績、當日業績、櫃位業績、公司業績、營收、出金、入金、每日結帳金額：使用 query_payout_report");
    expect(ASSISTANT_REPORT_TOOL_ROUTING).toContain("商品銷售數量、商品銷售額、SKU、商品分類、櫃位 POS 商品銷售：使用 query_sales_report");

    expect(PLATFORM_TOOL_DEFINITIONS.find((tool) => tool.key === "query_payout_report")).toMatchObject({
      label: "查詢業績／出金報表",
      description: expect.stringContaining("使用者說「業績」時，以這裡的 payoutAmount 回答"),
    });
  });

  it("小香內建資料工具在 target schema 上都能讀取新形狀", async () => {
    d1 = createTargetOnlyD1();
    env.DB = d1;
    const database = db();
    await syncSystemRoles(database);

    await database.insert(scopes).values({
      id: "cyberbiz:store:demo",
      sourceType: "cyberbiz",
      scopeKind: "store",
      name: "示範門市",
      normalizedName: "示範門市",
      active: 1,
    });
    await database.insert(itemCategories).values({ id: "cat-soap", name: "香氛皂", depth: 0 });
    await database.insert(items).values({
      id: "tool-item-1",
      source: "custom",
      kind: "sellable",
      sku: "SOAP-001",
      name: "薰衣草皂",
      categoryId: "cat-soap",
      active: 1,
    });
    await database.insert(wmsItems).values({ itemId: "tool-item-1", quantity: 2, unit: "件", minStock: 5, notes: "低庫存測試" });
    await database.insert(reportRuns).values({
      id: "report-run-tools",
      requestId: "report-run-tools",
      sourceType: "cyberbiz",
      importsSales: 1,
      importsPayout: 1,
      periodKind: "month",
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      status: "succeeded",
      actorEmail: "admin@ecotech.tw",
    });
    await database.insert(reportItemSalesMonthly).values({
      scopeId: "cyberbiz:store:demo",
      reportMonth: "2026-08",
      itemId: "tool-item-1",
      recordOrigin: "imported",
      reportRunId: "report-run-tools",
      grossQuantity: 3,
      returnQuantity: 1,
      netQuantity: 2,
      salesAmount: 640,
    });
    await database.insert(reportPayoutDaily).values({
      scopeId: "cyberbiz:store:demo",
      businessDate: "2026-08-01",
      recordOrigin: "imported",
      reportRunId: "report-run-tools",
      payoutAmount: 580,
    });
    await database.insert(crmCustomers).values({
      id: "tool-customer-1",
      phone: "0912-345-678",
      normalizedPhone: "0912345678",
      name: "王小香",
      email: "xiang@example.com",
      address: "台北市測試路 1 號",
      cyberbizCustomerId: "cyberbiz-customer-1",
      rawJson: JSON.stringify({ secret: "不應暴露" }),
      syncStatus: "synced",
    });
    await database.insert(crmTags).values({ id: "tag-vip", name: "VIP" });
    await database.insert(crmCustomerTags).values({ customerId: "tool-customer-1", crmTagId: "tag-vip" });
    await database.insert(activityEvents).values([
      {
        id: "tool-wms-event-1",
        entityType: "item",
        entityId: "tool-item-1",
        entityLabel: "薰衣草皂",
        eventType: "inventory_updated",
        summary: "更新庫存",
        source: "wms",
      },
      {
        id: "tool-crm-event-1",
        entityType: "customer",
        entityId: "tool-customer-1",
        entityLabel: "王小香",
        eventType: "customer_updated",
        summary: "更新客戶資料",
        source: "crm",
      },
    ]);

    const context = {
      surface: "sandbox",
      db: database,
      services: { cyberbizReports: createCyberbizReportService(database) },
    } as const;
    const execute = async (key: string, input: Record<string, string> = {}) => JSON.parse(
      await PLATFORM_TOOL_MAP.get(key)!.execute(input, context),
    ) as Record<string, unknown>;

    expect(await execute("wms_list_inventory", { pageSize: "10" })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: "tool-item-1", quantity: 2 })],
    });
    expect(await execute("wms_search_warehouse", { query: "薰衣草" })).toMatchObject({
      inventoryTotal: 1,
      inventoryItems: [expect.objectContaining({ id: "tool-item-1" })],
    });
    expect(await execute("wms_get_inventory_item", { id: "tool-item-1" })).toMatchObject({
      found: true,
      item: expect.objectContaining({ sku: "SOAP-001" }),
    });
    const listedItems = await execute("list_items", { search: "薰衣草", kind: "sellable" });
    expect(listedItems).toMatchObject({
      items: [expect.objectContaining({ itemId: "tool-item-1", sku: "SOAP-001", inWarehouse: true })],
    });
    expect(listedItems).not.toHaveProperty("items.0.quantity");
    expect(await execute("wms_list_low_stock_items")).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: "tool-item-1", quantity: 2, minStock: 5 })],
    });
    expect(await execute("wms_get_activity", { search: "庫存" })).toMatchObject({
      events: [expect.objectContaining({ entityId: "tool-item-1", summary: "更新庫存" })],
    });

    const customers = await execute("crm_search_customers", { search: "小香" });
    expect(customers).toMatchObject({
      total: 1,
      customers: [expect.objectContaining({ id: "tool-customer-1", name: "王小香" })],
    });
    expect(JSON.stringify(customers)).not.toContain("sourceChannel");
    expect(JSON.stringify(customers)).not.toContain("不應暴露");

    const customer = await execute("crm_get_customer", { customerId: "tool-customer-1", include: "events,tags" });
    expect(customer).toMatchObject({
      found: true,
      tags: ["VIP"],
      events: [expect.objectContaining({ customerId: "tool-customer-1", summary: "更新客戶資料" })],
    });
    expect(JSON.stringify(customer)).not.toContain("inCatalog");
    expect(JSON.stringify(customer)).not.toContain("不應暴露");

    expect(await execute("query_sales_report", { period: "2026-08", scopeType: "store", scopeName: "示範門市", itemIds: "tool-item-1" })).toMatchObject({
      status: "ok",
      rows: [expect.objectContaining({ sku: "SOAP-001" })],
      totals: expect.objectContaining({ netQuantity: 2, salesAmount: 640 }),
    });
    expect(await execute("query_payout_report", { period: "2026-08", scopeType: "store", scopeName: "示範門市" })).toMatchObject({
      status: "ok",
      totals: expect.objectContaining({ payoutAmount: 580 }),
    });
  });

  it("Sandbox 可以透過共用 registry 搜尋 WMS 商品與位置", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    await db().insert(items).values({ id: "wms-item-1", source: "custom", kind: "supply", sku: "BOX-001", name: "紙箱", active: 1 });
    await db().insert(wmsItems).values({ itemId: "wms-item-1", quantity: 3, unit: "件", minStock: 5, notes: "" });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      const hasToolResult = JSON.stringify(body.contents).includes("wms-item-1");
      if (hasToolResult) expect(JSON.stringify(body.contents)).toContain("call-wms-1");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: hasToolResult
          ? [{ text: "紙箱目前有 3 件，低於安全庫存 5 件。" }]
          : [{ functionCall: { id: "call-wms-1", name: "wms_search_warehouse", args: { query: "紙箱", scope: "inventory", limit: "10" } } }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", toolKeys: ["wms_search_warehouse"], input: "查詢紙箱庫存" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "紙箱目前有 3 件，低於安全庫存 5 件。",
      toolCalls: [{ toolKey: "wms_search_warehouse", status: "success", args: { query: "紙箱", scope: "inventory", limit: "10" } }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Sandbox 可以透過 WMS list tool 取得商品清單做 mapping", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    await db().insert(items).values([
      { id: "mapping-1", source: "custom", kind: "supply", sku: "BOX-001", name: "紙箱", active: 1 },
      { id: "mapping-2", source: "custom", kind: "supply", sku: "TAPE-001", name: "封箱膠帶", active: 1 },
    ]);
    await db().insert(wmsItems).values([
      { itemId: "mapping-1", quantity: 3, unit: "件", minStock: 5, notes: "" },
      { itemId: "mapping-2", quantity: 8, unit: "件", minStock: 5, notes: "" },
    ]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      const hasToolResult = JSON.stringify(body.contents).includes("mapping-1")
        && JSON.stringify(body.contents).includes("mapping-2");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: hasToolResult
          ? [{ text: "已取得 2 筆商品，可繼續做 SKU mapping。" }]
          : [{ functionCall: { name: "wms_list_inventory", args: { page: "1", pageSize: "100" } } }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", toolKeys: ["wms_list_inventory"], input: "列出所有商品" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "已取得 2 筆商品，可繼續做 SKU mapping。",
      toolCalls: [{ toolKey: "wms_list_inventory", status: "success" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Sandbox 可以查詢 WMS 地圖標籤與相對位置", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    await db().insert(wmsLayouts).values({ id: "layout-1", name: "測試地圖", canvasWidth: 1600, canvasHeight: 900, active: 1 });
    await db().insert(wmsLayoutElements).values([
      { id: "map-label-1", layoutId: "layout-1", elementType: "decoration", label: "冷藏區", color: "sky", x: 12, y: 18, width: 20, height: 10, zIndex: 0 },
      { id: "map-label-2", layoutId: "layout-1", elementType: "decoration", label: "大門入口", color: "rose", x: 40, y: 18, width: 12, height: 10, zIndex: 1 },
    ]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      const hasToolResult = JSON.stringify(body.contents).includes("map-label-1")
        && JSON.stringify(body.contents).includes("右側");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: hasToolResult
          ? [{ text: "冷藏區在大門入口的左側。" }]
          : [{ functionCall: { name: "wms_search_warehouse", args: { query: "冷藏", scope: "map" } } }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", toolKeys: ["wms_search_warehouse"], input: "冷藏區入口在哪裡？" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "冷藏區在大門入口的左側。",
      toolCalls: [{ toolKey: "wms_search_warehouse", status: "success" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Sandbox 可以透過共用 registry 查詢 CRM 客戶與背景", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    await db().insert(crmCustomers).values({
      id: "crm-customer-1",
      phone: "0912-345-678",
      normalizedPhone: "0912345678",
      name: "王小明",
      email: "ming@example.com",
      address: "台北市中山區測試路 1 號",
      cyberbizCustomerId: "cyberbiz-1",
      rawJson: JSON.stringify({ secret: "should-not-leak" }),
      syncStatus: "synced",
      createdAt: "2026-08-20 16:30:00",
      updatedAt: "2026-08-20 16:30:00",
    });
    await db().insert(crmCustomers).values({
      id: "crm-customer-2",
      phone: "0922-345-678",
      normalizedPhone: "0922345678",
      name: "陳小華",
      createdAt: "2026-08-20 15:59:59",
      updatedAt: "2026-08-20 15:59:59",
    });
    await db().insert(crmTags).values([
      { id: "tag-vip", name: "VIP" },
      { id: "tag-north", name: "北區" },
    ]);
    await db().insert(crmCustomerTags).values([
      { customerId: "crm-customer-1", crmTagId: "tag-vip" },
      { customerId: "crm-customer-1", crmTagId: "tag-north" },
    ]);
    await db().insert(activityEvents).values({
      id: "crm-event-1",
      entityType: "customer",
      entityId: "crm-customer-1",
      entityLabel: "王小明",
      eventType: "customer_updated",
      summary: "更新客戶資料",
      actorType: "user",
      actorEmail: "admin@ecotech.tw",
      source: "crm",
    });

    const requestBodies: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[]; systemInstruction?: unknown };
      const contents = JSON.stringify(body.contents);
      requestBodies.push(contents);
      if (requestBodies.length === 1) {
        expect(JSON.stringify(body.systemInstruction)).toContain("Asia/Taipei");
        expect(JSON.stringify(body.systemInstruction)).toContain("query_sales_report");
        expect(JSON.stringify(body.systemInstruction)).toContain("不要使用 crm_get_orders");
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_search_customers",
            args: { search: "", date: "2026-08-21", dateField: "createdAt", limit: "10" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (requestBodies.length === 2) {
        expect(contents).toContain("crm-customer-1");
        expect(contents).not.toContain("crm-customer-2");
        expect(contents).not.toContain("should-not-leak");
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_get_customer",
            args: { customerId: "crm-customer-1", include: "events,tags", eventLimit: "5" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      expect(contents).toContain("更新客戶資料");
      expect(contents).not.toContain("should-not-leak");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "找到王小明，CRM 顯示他是 VIP 客戶，最近有更新資料紀錄。" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["crm_search_customers", "crm_get_customer"],
        input: "請查詢王小明最近的 CRM 狀態",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "找到王小明，CRM 顯示他是 VIP 客戶，最近有更新資料紀錄。",
      toolCalls: [
        { toolKey: "crm_search_customers", status: "success" },
        { toolKey: "crm_get_customer", status: "success" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("Sandbox 可以即時查詢 CYBERBIZ 客戶訂單並只回傳整理後的資料", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    await db().insert(crmCustomers).values({
      id: "crm-customer-order-1",
      phone: "0912-345-678",
      normalizedPhone: "0912345678",
      name: "王小明",
      email: "ming@example.com",
      cyberbizCustomerId: "cyberbiz-7",
      rawJson: JSON.stringify({ secret: "should-not-leak" }),
      createdAt: "2026-08-20 16:30:00",
      updatedAt: "2026-08-20 16:30:00",
    });

    let geminiCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/orders")) {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer cyberbiz-test-token");
        return new Response(JSON.stringify([{
          id: 99,
          order_number: "R-00099",
          created_at: "2026-08-21 10:20:30",
          customer: { id: "cyberbiz-7", name: "王小明", email: "ming@example.com", mobile: "0912345678" },
          prices: { total_price: 1_280 },
          statuses: { financial_status: "paid", fulfillment_status: "fulfilled" },
          line_items: [{ title: "測試商品", sku: "SKU-1", quantity: 2, price: 640 }],
        }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      geminiCalls += 1;
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      if (geminiCalls === 1) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_get_orders",
            args: { customerId: "crm-customer-order-1", fromDate: "2026-08-21", toDate: "2026-08-21" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      expect(JSON.stringify(body.contents)).toContain("R-00099");
      expect(JSON.stringify(body.contents)).not.toContain("should-not-leak");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "王小明今天有 1 筆已付款訂單，金額為 1,280 元。" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["crm_get_orders"],
        input: "請查詢王小明今天的消費紀錄",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "王小明今天有 1 筆已付款訂單，金額為 1,280 元。",
      toolCalls: [{ toolKey: "crm_get_orders", status: "success" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("沒有搜尋條件時使用 CYBERBIZ customer orders endpoint 並套用 limit", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    await db().insert(crmCustomers).values({
      id: "crm-customer-order-direct-1",
      phone: "0912-345-678",
      normalizedPhone: "0912345678",
      name: "王小明",
      email: "ming@example.com",
      cyberbizCustomerId: "cyberbiz-direct-7",
      createdAt: "2026-08-20 16:30:00",
      updatedAt: "2026-08-20 16:30:00",
    });

    let geminiCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/customers/cyberbiz-direct-7/orders")) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("per_page")).toBe("5");
        expect(parsed.searchParams.get("offset")).toBe("0");
        return new Response(JSON.stringify([{
          id: 100,
          order_number: "R-00100",
          created_at: "2026-08-21 10:20:30",
          customer: { id: "cyberbiz-direct-7", name: "王小明" },
          prices: { total_price: 1_280 },
        }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      geminiCalls += 1;
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      if (geminiCalls === 1) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_get_orders",
            args: { customerId: "crm-customer-order-direct-1", limit: "5" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      expect(JSON.stringify(body.contents)).toContain("R-00100");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "王小明最近有 1 筆訂單。" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["crm_get_orders"],
        input: "請查詢王小明最近五筆訂單",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "王小明最近有 1 筆訂單。",
      toolCalls: [{ toolKey: "crm_get_orders", status: "success" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("可以用 orderIds 直接取得多筆 CYBERBIZ 訂單明細", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");

    let geminiCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/orders/")) {
        const orderId = url.endsWith("/201") ? "201" : "202";
        return new Response(JSON.stringify({ order: {
          id: orderId,
          order_number: `R-${orderId}`,
          created_at: orderId === "201" ? "2026-08-20 10:00:00" : "2026-08-21 10:00:00",
          prices: { total_price: orderId === "201" ? 100 : 200 },
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      geminiCalls += 1;
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      if (geminiCalls === 1) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_get_orders",
            args: { orderIds: "201,202", sortBy: "orderNumber", sortDirection: "asc" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      expect(JSON.stringify(body.contents)).toContain("R-201");
      expect(JSON.stringify(body.contents)).toContain("R-202");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "已取得兩筆訂單明細。" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["crm_get_orders"],
        input: "查詢訂單 201 與 202",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "已取得兩筆訂單明細。",
      toolCalls: [{ toolKey: "crm_get_orders", status: "success" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("可以用使用者看到的訂單編號先 mapping 再取得訂單明細", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");

    let geminiCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/orders/get_order_id")) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("order_numbers")).toBe("56714");
        return new Response(JSON.stringify([{ order_number: 56714, order_id: 301 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/v1/orders/56714")) {
        return new Response(JSON.stringify({ error: "找不到訂單 ID" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/v1/orders/301")) {
        return new Response(JSON.stringify({ order: {
          id: 301,
          order_number: 56714,
          order_name: "56714",
          created_at: "2026-08-21 10:00:00",
          customer: { id: 7, name: "許櫻齡", email: "ying@example.com" },
          prices: { total_price: 1_680 },
          line_items: [{ title: "測試商品", quantity: 1, price: 1_680 }],
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      geminiCalls += 1;
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      if (geminiCalls === 1) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_get_orders",
            args: { orderId: "56714" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      expect(JSON.stringify(body.contents)).toContain("許櫻齡");
      expect(JSON.stringify(body.contents)).toContain("56714");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "訂單 #56714 由許櫻齡購買，金額為 1,680 元。" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["crm_get_orders"],
        input: "#56714 這筆訂單內容是什麼？誰購買的？",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "訂單 #56714 由許櫻齡購買，金額為 1,680 元。",
      toolCalls: [{ toolKey: "crm_get_orders", status: "success" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("訂單編號 mapping 後仍找不到時不暴露 CYBERBIZ internal order ID", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");

    let geminiCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/orders/get_order_id")) {
        const parsed = new URL(url);
        if (parsed.searchParams.get("order_numbers") === "56714") {
          return new Response(JSON.stringify([{ order_number: 56714, order_id: 301 }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/v1/orders/301")) {
        return new Response(JSON.stringify({ error: "找不到訂單" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      geminiCalls += 1;
      if (geminiCalls === 1) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_get_orders",
            args: { orderNumber: "#56714" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      const contents = JSON.stringify(body.contents);
      expect(contents).toContain("notFoundOrderNumbers");
      expect(contents).toContain("56714");
      expect(contents).not.toContain("notFoundOrderIds");
      expect(contents).not.toContain("301");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "找不到訂單 #56714。" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["crm_get_orders"],
        input: "查詢訂單 #56714",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "找不到訂單 #56714。",
      toolCalls: [{ toolKey: "crm_get_orders", status: "success" }],
    });
    expect(geminiCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("工具失敗時會把錯誤回傳給 Gemini 產生可理解的回覆", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");

    let geminiCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/orders/301")) {
        return new Response(JSON.stringify({ error: "權限不足" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      geminiCalls += 1;
      if (geminiCalls === 1) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_get_orders",
            args: { orderId: "301" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const contents = JSON.stringify(body.contents);
      expect(contents).toContain("CYBERBIZ API 401");
      expect(contents).toContain("權限不足");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "訂單查詢工具目前沒有權限，我先不猜測訂單狀態。" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["crm_get_orders"],
        input: "查詢訂單 301",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "訂單查詢工具目前沒有權限，我先不猜測訂單狀態。",
      toolCalls: [{ toolKey: "crm_get_orders", status: "failed", errorMessage: "CYBERBIZ API 401: 權限不足" }],
    });
    expect(geminiCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("Gemini 第二輪請求失敗時仍回傳前一輪的 tool 參數供 Sandbox debug", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");

    let geminiCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      geminiCalls += 1;
      if (geminiCalls === 1) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "wms_list_inventory",
            args: { page: "1", pageSize: "5" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: "invalid function response" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["wms_list_inventory"],
        input: "列出商品",
      }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("診斷編號"),
      runId: expect.any(String),
      toolCalls: [{ toolKey: "wms_list_inventory", status: "success", args: { page: "1", pageSize: "5" } }],
    });
    expect(geminiCalls).toBe(2);
  });

  it("使用選定 prompt 與模型執行 Gemini，並記錄可用量資訊", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "這是 Gemini 的測試回覆。" }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", toolKeys: [], input: "請回覆測試內容" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "這是 Gemini 的測試回覆。",
      model: "gemini-3.6-flash",
      usage: { promptTokens: 12, candidateTokens: 8, totalTokens: 20 },
      toolCalls: [],
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("Gemma 4 Sandbox 將 thought channel 與正式回答分開", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [
        { text: "這是模型的內部思考", thought: true },
        { text: "這是給使用者的正式回答" },
      ] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gemma-4-31b-it", toolKeys: [], input: "請回答測試問題" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "這是給使用者的正式回答",
      thoughts: "這是模型的內部思考",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string; includeThoughts?: boolean } };
    };
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 1_200,
      thinkingConfig: { thinkingLevel: "MINIMAL", includeThoughts: true },
    });
  });

  it("Sandbox session 會保留多輪對話，關閉後不能繼續執行", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const configResponse = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config");
    const config = await configResponse.json() as { activePrompt: { id: string } };
    const createdResponse = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { session: { id: string; status: string; messages: unknown[] } };
    expect(created.session).toMatchObject({ status: "open", messages: [] });

    const geminiBodies: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      geminiBodies.push(typeof init?.body === "string" ? init.body : "");
      const text = geminiBodies.length === 1 ? "第一輪回答" : "第二輪回答";
      const parts = geminiBodies.length === 1
        ? [{ text: "第一輪 thinking", thought: true }, { text }]
        : [{ text }];
      return new Response(JSON.stringify({
        candidates: [{ content: { parts } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const firstRun = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.session.id, model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id, toolKeys: [], input: "第一輪問題" }),
    });
    expect(firstRun.status).toBe(200);
    expect(await firstRun.json()).toMatchObject({ sessionId: created.session.id, text: "第一輪回答", thoughts: "第一輪 thinking" });

    const secondRun = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.session.id, model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id, toolKeys: [], input: "第二輪問題" }),
    });
    expect(secondRun.status).toBe(200);
    expect(await secondRun.json()).toMatchObject({ sessionId: created.session.id, text: "第二輪回答" });
    expect(geminiBodies[1]).toContain("第一輪問題");
    expect(geminiBodies[1]).toContain("第一輪回答");

    const detail = await as("admin", "admin@ecotech.tw", `/api/assistant/sandbox/sessions/${created.session.id}`);
    const detailResult = await detail.json() as { session: { messages: Array<{ role: string; text: string; thoughts: string }> } };
    expect(detailResult.session.messages).toEqual([
      { role: "user", text: "第一輪問題", model: "", thoughts: "", toolCalls: [], attachments: [], durationMs: 0, id: expect.any(String), createdAt: expect.any(String) },
      { role: "model", text: "第一輪回答", model: "gemini-3.6-flash", thoughts: "第一輪 thinking", toolCalls: [], attachments: [], durationMs: expect.any(Number), id: expect.any(String), createdAt: expect.any(String) },
      { role: "user", text: "第二輪問題", model: "", thoughts: "", toolCalls: [], attachments: [], durationMs: 0, id: expect.any(String), createdAt: expect.any(String) },
      { role: "model", text: "第二輪回答", model: "gemini-3.6-flash", thoughts: "", toolCalls: [], attachments: [], durationMs: expect.any(Number), id: expect.any(String), createdAt: expect.any(String) },
    ]);

    const closed = await as("admin", "admin@ecotech.tw", `/api/assistant/sandbox/sessions/${created.session.id}/close`, { method: "POST" });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ session: { status: "closed" } });

    const rejected = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.session.id, model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id, toolKeys: [], input: "不應該送出" }),
    });
    expect(rejected.status).toBe(409);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("同一個 Sandbox session 可以在每一輪切換模型，並記錄每則回答的實際模型", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const config = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config")).json() as { activePrompt: { id: string } };
    const created = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id }),
    })).json() as { session: { id: string } };
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "回答 " + urls.length }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const first = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.session.id, model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id, toolKeys: [], input: "先用 Flash" }),
    });
    const second = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.session.id, model: "gemma-4-31b-it", promptRevisionId: config.activePrompt.id, toolKeys: [], input: "改用 Gemma" }),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(urls[0]).toContain("/gemini-3.6-flash:");
    expect(urls[1]).toContain("/gemma-4-31b-it:");

    const detail = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions/" + created.session.id);
    const result = await detail.json() as { session: { model: string; messages: Array<{ model: string }> } };
    expect(result.session.model).toBe("gemma-4-31b-it");
    expect(result.session.messages.map((message) => message.model)).toEqual(["", "gemini-3.6-flash", "", "gemma-4-31b-it"]);
  });

  it("同一個 Sandbox session 可以套用新 prompt revision", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const config = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config")).json() as { activePrompt: { id: string } };
    const created = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id }),
    })).json() as { session: { id: string } };
    const revision = await (await as("admin", "admin@ecotech.tw", "/api/assistant/prompts", {
      method: "POST",
      body: JSON.stringify({ systemPrompt: "這是新的 session prompt。" }),
    })).json() as { revision: { id: string } };
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "使用新 prompt 回覆" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.session.id, model: "gemini-3.6-flash", promptRevisionId: revision.revision.id, toolKeys: [], input: "套用新 prompt" }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(requests[0]?.systemInstruction)).toContain("這是新的 session prompt。");

    const detail = await as("admin", "admin@ecotech.tw", `/api/assistant/sandbox/sessions/${created.session.id}`);
    expect(await detail.json()).toMatchObject({ session: { promptRevisionId: revision.revision.id } });
  });

  it("Sandbox session 超過 100 則訊息時仍取最近的對話", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const config = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config")).json() as { activePrompt: { id: string } };
    const created = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id }),
    })).json() as { session: { id: string } };
    for (let index = 0; index < 51; index += 1) {
      await appendAssistantSandboxMessage(db(), { sessionId: created.session.id, role: "user", text: `歷史問題 ${index}` });
      await appendAssistantSandboxMessage(db(), { sessionId: created.session.id, role: "model", text: `歷史回答 ${index}`, model: "gemini-3.6-flash" });
    }
    let requestBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "最新回答" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.session.id, model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id, toolKeys: [], input: "最新問題" }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(requestBody?.contents)).toContain("歷史問題 50");
  });

  it("長對話由 Pi compact，D1 仍保留完整稽核歷史", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const config = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config")).json() as { activePrompt: { id: string } };
    const created = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id }),
    })).json() as { session: { id: string } };
    const requests: Array<{ body: Record<string, unknown>; summary: boolean }> = [];
    let mainCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const systemPrompt = JSON.stringify(body.systemInstruction);
      const summary = systemPrompt.includes("context summarization assistant");
      requests.push({ body, summary });
      const text = summary ? "已更新摘要" : "長對話回答 " + ++mainCount;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const longQuestion = "問題".repeat(3_500);
    for (let index = 0; index < 30; index += 1) {
      const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
        method: "POST",
        body: JSON.stringify({
          sessionId: created.session.id,
          model: "gemini-3.6-flash",
          promptRevisionId: config.activePrompt.id,
          toolKeys: [],
          input: longQuestion + index,
        }),
      });
      expect(response.status).toBe(200);
    }

    expect(requests.some((request) => request.summary)).toBe(true);
    const lastMainRequest = requests.filter((request) => !request.summary).at(-1);
    expect(JSON.stringify(lastMainRequest?.body.contents)).toContain("已更新摘要");
    expect(JSON.stringify(lastMainRequest?.body.contents)).not.toContain(longQuestion + "0");

    const detail = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions/" + created.session.id);
    const result = await detail.json() as {
      session: { contextSummaryMessageCount: number; messages: unknown[] };
    };
    expect(result.session.contextSummaryMessageCount).toBe(0);
    expect(result.session.messages).toHaveLength(60);
  });

  it("既有 DO state 留著舊模型時，背景 compact 會改用預設 Codex 模型", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    env.ASSISTANT_CREDENTIAL_VAULT = {
      getByName: () => ({
        fetch: async (request: Request) => request.url.endsWith("/status")
          ? Response.json({ configured: true })
          : Response.json({ accessToken: CODEX_ACCESS_TOKEN, configured: true }),
      }),
    };
    const config = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config")).json() as { activePrompt: { id: string } };
    const created = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.4-mini", promptRevisionId: config.activePrompt.id }),
    })).json() as { session: { id: string } };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "初始化回答" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        ...requestBody,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        sessionId: created.session.id,
        model: "gpt-5.4-mini",
        promptRevisionId: config.activePrompt.id,
        toolKeys: [],
        input: "建立舊 session",
      }),
    });
    expect(response.status).toBe(200);

    const agentName = `rueisiang-xiaoxiang:sandbox:admin:${created.session.id}`;
    assistantAgents!.seedLegacyCompactionState(agentName, "gemini-1.5-pro");
    fetchMock.mockResolvedValue(asCodexStream({
      candidates: [{ content: { parts: [{ text: "legacy history summary" }] } }],
    }));

    await expect(assistantAgents!.alarm(agentName)).resolves.toBeUndefined();
    expect(assistantAgents!.model(agentName)).toBe("gpt-5.4-mini");
  });

  it("Sandbox compact 遇到 HTML provider error 時不把整頁回傳給 UI", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const config = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config")).json() as { activePrompt: { id: string } };
    const created = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id }),
    })).json() as { session: { id: string } };
    const messages = Array.from({ length: 40 }, (_, index) => [
      {
        id: `compact-error-user-${index}`,
        sessionId: created.session.id,
        role: "user" as const,
        text: `歷史問題-${index} ${"歷史".repeat(3_000)}`,
        createdAt: new Date(Date.UTC(2026, 7, 22, 10, index, 0)).toISOString(),
      },
      {
        id: `compact-error-model-${index}`,
        sessionId: created.session.id,
        role: "model" as const,
        text: `歷史回答-${index} ${"回答".repeat(3_000)}`,
        model: "gemini-3.6-flash",
        createdAt: new Date(Date.UTC(2026, 7, 22, 10, index, 30)).toISOString(),
      },
    ]).flat();
    await db().insert(assistantSandboxMessages).values(messages);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (JSON.stringify(body.systemInstruction).includes("context summarization assistant")) {
        return new Response("<!doctype html><html><body>Unable to load site</body></html>", {
          status: 403,
          headers: { "Content-Type": "text/html", "CF-Ray": "compact-ray" },
        });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "不應該執行到主回答" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        sessionId: created.session.id,
        model: "gemini-3.6-flash",
        promptRevisionId: config.activePrompt.id,
        toolKeys: [],
        input: "觸發摘要錯誤",
      }),
    });
    const result = await response.json() as { text: string };
    expect(response.status).toBe(200);
    expect(result.text).toBe("不應該執行到主回答");
  });
});
