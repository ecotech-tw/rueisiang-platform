import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, listPayoutStores, seedPayoutStores, syncSystemRoles, upsertReportScope } from "@rueisiang/db";
import { payoutRuns, payoutStores, reportPayoutDaily, reportScopes, userRoles, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { manualScopeIdFromStoreName } from "./cyberbiz-scope.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

/**
 * 出金表。
 *
 * 這裡最重要的是「平台不碰任何憑證」——它只 workflow_dispatch 一個 GitHub Actions
 * 工作。所以測試盯的是：送出去的 inputs 對不對、誰能按、以及 GitHub 拒絕時
 * 本地有沒有留下一筆看起來跑過的紀錄。
 */

const SECRET = "test-secret";
let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

/** 把 GitHub API 換成可控的替身，記下打了什麼。 */
function stubGithub(responses: { status?: number; body?: unknown }[] = [{ body: {} }]) {
  const calls: { url: string; method: string; body: unknown; headers: Headers }[] = [];
  let index = 0;

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: new Headers(init?.headers),
    });
    const spec = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    return new Response(JSON.stringify(spec.body ?? {}), { status: spec.status ?? 200 });
  });

  return calls;
}

async function seedUser(email: string, roleId: string) {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: "active" });
  await db().insert(userRoles).values({ userId: id, roleId });
  return id;
}

async function as(userId: string, email: string, path: string, init: RequestInit = {}) {
  const token = await signSession(
    newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }),
    SECRET,
  );
  return app.fetch(
    new Request(`https://platform.rueisiang.com${path}`, {
      ...init,
      headers: {
        Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    }),
    env as never,
  );
}

const RANGE = { start: "2026-07-01", end: "2026-07-31" };

beforeEach(async () => {
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    GITHUB_TOKEN: "gh-token",
    PAYOUT_GITHUB_REPO: "ecotech-tw/rueisiang-tool-billing",
    PAYOUT_WORKFLOW_FILE: "payout.yml",
    PAYOUT_GITHUB_REF: "main",
  };
  await syncSystemRoles(db());
  await seedPayoutStores(db());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("店別種子", () => {
  it("空的時候塞入正式在跑的九家店", async () => {
    expect(await db().select().from(payoutStores)).toHaveLength(9);
  });

  it("已經有資料就完全不動——那是同仁自己維護的東西", async () => {
    await db().delete(payoutStores);
    await db().insert(payoutStores).values({ id: "s1", name: "只有這一家" });

    await seedPayoutStores(db());
    const rows = await db().select().from(payoutStores);
    expect(rows.map((row) => row.name)).toEqual(["只有這一家"]);
  });

  it("預設店別都是顯示中的", async () => {
    expect((await listPayoutStores(db())).every((store) => store.enabled)).toBe(true);
  });
});

describe("執行", () => {
  it("全部店別送出 store=全部，並帶上識別碼", async () => {
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const names = (await db().select().from(payoutStores)).map((row) => row.name);

    const response = await as(id, "manager@ecotech.tw", "/api/tools/payout/run", {
      method: "POST",
      body: JSON.stringify({ stores: names, ...RANGE }),
    });
    expect(response.status).toBe(202);

    const dispatch = calls[0]!;
    expect(dispatch.url).toContain("/actions/workflows/payout.yml/dispatches");
    expect(dispatch.body).toMatchObject({
      ref: "main",
      inputs: { store: "全部", start: "2026-07-01", end: "2026-07-31", skip_upload: false },
    });
    // GitHub 沒有 User-Agent 會直接拒絕。
    expect(dispatch.headers.get("User-Agent")).toBeTruthy();

    const { requestId } = (await response.json()) as { requestId: string };
    expect((dispatch.body as { inputs: { request_id: string } }).inputs.request_id).toBe(requestId);
  });

  it("單一店別照原樣送出", async () => {
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    await as(id, "manager@ecotech.tw", "/api/tools/payout/run", {
      method: "POST",
      body: JSON.stringify({ stores: ["宏匯廣場1F"], ...RANGE }),
    });

    expect((calls[0]!.body as { inputs: { store: string } }).inputs.store).toBe("宏匯廣場1F");
  });

  it("多家但不是全部時送出店名 JSON 陣列", async () => {
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const names = (await listPayoutStores(db())).slice(0, 2).map((store) => store.name);

    const response = await as(id, "manager@ecotech.tw", "/api/tools/payout/run", {
      method: "POST",
      body: JSON.stringify({ stores: names, ...RANGE }),
    });

    expect(response.status).toBe(202);
    expect((calls[0]!.body as { inputs: { store: string } }).inputs.store).toBe(JSON.stringify(names));
  });

  it("記下是誰按的——出問題時第一個要問的就是這個", async () => {
    stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    await as(id, "manager@ecotech.tw", "/api/tools/payout/run", {
      method: "POST",
      body: JSON.stringify({ stores: ["宏匯廣場1F"], ...RANGE }),
    });

    const [record] = await db().select().from(payoutRuns);
    expect(record).toMatchObject({
      actorEmail: "manager@ecotech.tw",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      storesJson: JSON.stringify(["宏匯廣場1F"]),
    });
  });

  it("GitHub 拒絕時本地不留紀錄", async () => {
    stubGithub([{ status: 403, body: { message: "no" } }]);
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    const response = await as(id, "manager@ecotech.tw", "/api/tools/payout/run", {
      method: "POST",
      body: JSON.stringify({ stores: ["宏匯廣場1F"], ...RANGE }),
    });

    expect(response.status).toBe(502);
    expect(await db().select().from(payoutRuns)).toHaveLength(0);
  });

  it.each([
    ["不認得的通路", { stores: ["蝦皮"], ...RANGE }],
    ["沒選店", { stores: [], ...RANGE }],
    ["店別重複", { stores: ["宏匯廣場1F", "宏匯廣場1F"], ...RANGE }],
    ["日期格式錯", { stores: ["宏匯廣場1F"], start: "2026/07/01", end: "2026-07-31" }],
    // 日曆上不存在的日子：Date 會自己捲到 3/2，不比對回去就會放它過。
    ["不存在的日期", { stores: ["宏匯廣場1F"], start: "2026-02-30", end: "2026-02-30" }],
    ["起日晚於迄日", { stores: ["宏匯廣場1F"], start: "2026-07-31", end: "2026-07-01" }],
  ])("擋下不合法的輸入（%s）", async (_label, payload) => {
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    const response = await as(id, "manager@ecotech.tw", "/api/tools/payout/run", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(400);
    // 擋下來就不該打到 GitHub。
    expect(calls).toHaveLength(0);
  });

  it("沒設 token 時說得出原因，不是 500", async () => {
    stubGithub();
    env = { ...env, GITHUB_TOKEN: undefined };
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    const response = await as(id, "manager@ecotech.tw", "/api/tools/payout/run", {
      method: "POST",
      body: JSON.stringify({ stores: ["宏匯廣場1F"], ...RANGE }),
    });
    expect(response.status).toBe(503);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("GITHUB_TOKEN"),
    });
  });

  it("state 帶回最近一次的識別碼，重新整理才接得回去", async () => {
    stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const run = await as(id, "manager@ecotech.tw", "/api/tools/payout/run", {
      method: "POST",
      body: JSON.stringify({ stores: ["宏匯廣場1F"], ...RANGE }),
    });
    const { requestId } = (await run.json()) as { requestId: string };

    const state = await as(id, "manager@ecotech.tw", "/api/tools/payout/state");
    expect((await state.json()) as { latestRequestId: string }).toMatchObject({
      latestRequestId: requestId,
    });
  });

  it("關閉的店別不會出現在執行頁，也不能被 API 繞過", async () => {
    const [hidden] = await listPayoutStores(db());
    await db().update(payoutStores).set({ enabled: false }).where(eq(payoutStores.id, hidden!.id));
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    const state = await as(id, "manager@ecotech.tw", "/api/tools/payout/state");
    const stateBody = (await state.json()) as { stores: { name: string }[] };
    expect(stateBody.stores.some((store) => store.name === hidden!.name)).toBe(false);

    const response = await as(id, "manager@ecotech.tw", "/api/tools/payout/run", {
      method: "POST",
      body: JSON.stringify({ stores: [hidden!.name], ...RANGE }),
    });
    expect(response.status).toBe(400);
  });

  it("全選啟用店別時不會把隱藏店送給 runner", async () => {
    const calls = stubGithub();
    const [hidden] = await listPayoutStores(db());
    await db().update(payoutStores).set({ enabled: false }).where(eq(payoutStores.id, hidden!.id));
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const names = (await listPayoutStores(db(), { enabledOnly: true })).map((store) => store.name);

    const response = await as(id, "manager@ecotech.tw", "/api/tools/payout/run", {
      method: "POST",
      body: JSON.stringify({ stores: names, ...RANGE }),
    });

    expect(response.status).toBe(202);
    expect((calls[0]!.body as { inputs: { store: string } }).inputs.store).toBe(JSON.stringify(names));
  });

  it("檢視者不能執行", async () => {
    stubGithub();
    const id = await seedUser("viewer@ecotech.tw", "role-viewer");
    const response = await as(id, "viewer@ecotech.tw", "/api/tools/payout/run", {
      method: "POST",
      body: JSON.stringify({ stores: ["宏匯廣場1F"], ...RANGE }),
    });
    expect(response.status).toBe(403);
  });

  it("沒登入的人連狀態都讀不到", async () => {
    const response = await app.fetch(
      new Request("https://platform.rueisiang.com/api/tools/payout/state"),
      env as never,
    );
    expect(response.status).toBe(401);
  });
});

describe("查狀態", () => {
  it("用識別碼從清單裡認出自己那一次", async () => {
    stubGithub([
      {
        body: {
          workflow_runs: [
            { id: 2, status: "completed", conclusion: "success", created_at: "2026-08-01T00:00:00Z", html_url: "https://gh/2", display_title: "出金表｜全部｜req-other" },
            { id: 1, status: "completed", conclusion: "success", created_at: "2026-08-01T00:00:00Z", html_url: "https://gh/1", display_title: "出金表｜全部｜req-mine" },
          ],
        },
      },
    ]);
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    const response = await as(id, "manager@ecotech.tw", "/api/tools/payout/status?requestId=req-mine");
    const body = (await response.json()) as { runs: { id: number }[] };
    expect(body.runs.map((run) => run.id)).toEqual([1]);
  });

  it("還在跑的時候才多問一次步驟", async () => {
    const calls = stubGithub([
      {
        body: {
          workflow_runs: [
            { id: 7, status: "in_progress", conclusion: null, created_at: "2026-08-01T00:00:00Z", html_url: "https://gh/7", display_title: "req-mine" },
          ],
        },
      },
      { body: { jobs: [{ steps: [{ name: "登入 CYBERBIZ", status: "completed", conclusion: "success" }] }] } },
    ]);
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    const response = await as(id, "manager@ecotech.tw", "/api/tools/payout/status?requestId=req-mine");
    const body = (await response.json()) as { steps: { name: string }[] };

    expect(body.steps.map((step) => step.name)).toEqual(["登入 CYBERBIZ"]);
    expect(calls[1]?.url).toContain("/actions/runs/7/jobs");
  });
});

describe("手動上傳出金", () => {
  it("長店名的 scope ID 保留雜湊，不會因截斷前綴而碰撞", () => {
    const first = manualScopeIdFromStoreName(`${"長店名".repeat(40)}甲`);
    const second = manualScopeIdFromStoreName(`${"長店名".repeat(40)}乙`);

    expect(first).not.toBe(second);
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(100);
  });

  it("同一天的輸入會先加總，再以單筆資料寫入並回傳相同合計", async () => {
    const id = await seedUser("manual@ecotech.tw", "role-admin");
    const response = await as(id, "manual@ecotech.tw", "/api/tools/manual-payout", {
      method: "POST",
      body: JSON.stringify({
        scopeName: "退租店",
        rows: [
          { businessDate: "2026-07-01", payoutAmount: 100 },
          { businessDate: "2026-07-01", payoutAmount: 25 },
          { businessDate: "2026-07-02", payoutAmount: 50 },
        ],
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ dayCount: 2, total: 175, coverageStart: "2026-07-01", coverageEnd: "2026-07-02" });
    expect((await db().select().from(reportPayoutDaily)).map((row) => [row.businessDate, row.payoutAmount])).toEqual([
      ["2026-07-01", 125],
      ["2026-07-02", 50],
    ]);
  });

  it.each([
    ["日曆上不存在的日期", { businessDate: "2026-02-31", payoutAmount: 100 }],
    ["超出安全整數範圍的金額", { businessDate: "2026-07-01", payoutAmount: Number.MAX_SAFE_INTEGER + 1 }],
  ])("擋下不合法的資料（%s）且不建立 scope", async (_label, row) => {
    const id = await seedUser("invalid-manual@ecotech.tw", "role-admin");
    const response = await as(id, "invalid-manual@ecotech.tw", "/api/tools/manual-payout", {
      method: "POST",
      body: JSON.stringify({ scopeName: "不應建立", rows: [row] }),
    });

    expect(response.status).toBe(400);
    expect((await db().select().from(reportScopes)).some((scope) => scope.id !== "company")).toBe(false);
    expect(await db().select().from(reportPayoutDaily)).toHaveLength(0);
  });

  it("不認得的既有 scope 會改用可納入公司總計的 manual scope", async () => {
    await upsertReportScope(db(), { id: "invalid-scope-id", scopeKind: "store", name: "舊店" });
    const id = await seedUser("manual-scope@ecotech.tw", "role-admin");
    const response = await as(id, "manual-scope@ecotech.tw", "/api/tools/manual-payout", {
      method: "POST",
      body: JSON.stringify({
        scopeId: "invalid-scope-id",
        scopeName: "退租店",
        rows: [{ businessDate: "2026-07-01", payoutAmount: 100 }],
      }),
    });

    expect(response.status).toBe(201);
    const result = await response.json() as { scopeId: string };
    expect(result.scopeId).toMatch(/^manual:store:/);
    expect((await db().select().from(reportPayoutDaily))[0]?.scopeId).toBe(result.scopeId);

    const scopes = await as(id, "manual-scope@ecotech.tw", "/api/tools/manual-payout/scopes");
    expect((await scopes.json()) as { scopes: { id: string }[] }).toEqual({ scopes: [{ id: result.scopeId, name: "退租店" }] });
  });
});

describe("店別設定", () => {
  /** 讀 stores.json 的回應（GitHub 的 Contents API 回 base64）。 */
  function storesFile(stores: unknown) {
    const text = `${JSON.stringify({ stores }, null, 2)}
`;
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { sha: "old-sha", content: btoa(binary) };
  }

  const TWO_STORES = [
    { name: "乙店", driveFolderUrl: "", driveFolderName: "" },
    { name: "甲店", driveFolderUrl: "https://drive.google.com/drive/folders/abc123", driveFolderName: "甲" },
  ];

  it("顯示開關直接生效，且不會改寫 runner 的 stores.json", async () => {
    const calls = stubGithub();
    const [store] = await listPayoutStores(db());
    const id = await seedUser("eli@ecotech.tw", "role-admin");

    const response = await as(id, "eli@ecotech.tw", `/api/tools/payout/stores/${store!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { store: { id: string; enabled: boolean } }).toMatchObject({
      store: { id: store!.id, enabled: false },
    });
    expect((await listPayoutStores(db()))[0]!.enabled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("單店欄位自動儲存，並同步 runner 的 stores.json", async () => {
    const calls = stubGithub([{ body: storesFile([{ name: "舊的" }]) }, { body: {} }]);
    const [store] = await listPayoutStores(db());
    const id = await seedUser("eli@ecotech.tw", "role-admin");

    const response = await as(id, "eli@ecotech.tw", `/api/tools/payout/stores/${store!.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: "自動儲存測試店",
        driveFolderUrl: "https://drive.google.com/drive/folders/autosave",
        driveFolderName: "自動儲存",
        enabled: true,
      }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { store: { name: string } }).toMatchObject({
      store: { name: "自動儲存測試店" },
    });
    expect((await listPayoutStores(db()))[0]).toMatchObject({
      name: "自動儲存測試店",
      driveFolderName: "自動儲存",
    });
    expect(calls).toHaveLength(2);
    expect((calls[1]!.body as { content: string }).content).toBeTruthy();
    expect(new TextDecoder().decode(Uint8Array.from(atob((calls[1]!.body as { content: string }).content), (ch) => ch.charCodeAt(0))))
      .not.toContain("enabled");
  });

  it("新增店別自動儲存，並接在清單尾端", async () => {
    const calls = stubGithub([{ body: storesFile([{ name: "舊的" }]) }, { body: {} }]);
    const id = await seedUser("eli@ecotech.tw", "role-admin");

    const response = await as(id, "eli@ecotech.tw", "/api/tools/payout/stores", {
      method: "POST",
      body: JSON.stringify({
        name: "新增測試店",
        driveFolderUrl: "",
        driveFolderName: "",
        enabled: true,
      }),
    });

    expect(response.status).toBe(201);
    expect((await response.json()) as { store: { id: string; name: string } }).toMatchObject({
      store: { name: "新增測試店" },
    });
    expect((await listPayoutStores(db())).at(-1)!.name).toBe("新增測試店");
    expect(calls).toHaveLength(2);
  });

  it("刪除店別自動儲存，並同步 runner 的 stores.json", async () => {
    const calls = stubGithub([{ body: storesFile([{ name: "舊的" }]) }, { body: {} }]);
    const [store] = await listPayoutStores(db());
    const id = await seedUser("eli@ecotech.tw", "role-admin");

    const response = await as(id, "eli@ecotech.tw", `/api/tools/payout/stores/${store!.id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect((await listPayoutStores(db())).some((candidate) => candidate.id === store!.id)).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("整組換掉，順序照送進來的排", async () => {
    stubGithub([{ status: 404, body: {} }, { body: {} }]);
    const id = await seedUser("eli@ecotech.tw", "role-admin");
    const response = await as(id, "eli@ecotech.tw", "/api/tools/payout/stores", {
      method: "PUT",
      body: JSON.stringify({ stores: TWO_STORES }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { stores: { name: string }[] };
    expect(body.stores.map((store) => store.name)).toEqual(["乙店", "甲店"]);
  });

  it("commit 回帳務 repo 的 stores.json，帶上 sha 與是誰改的", async () => {
    const calls = stubGithub([{ body: storesFile([{ name: "舊的" }]) }, { body: {} }]);
    const id = await seedUser("eli@ecotech.tw", "role-admin");

    const response = await as(id, "eli@ecotech.tw", "/api/tools/payout/stores", {
      method: "PUT",
      body: JSON.stringify({ stores: TWO_STORES }),
    });
    expect((await response.json()) as { committed: boolean }).toMatchObject({
      syncedToRepo: true,
      committed: true,
    });

    const put = calls[1]!;
    expect(put.method).toBe("PUT");
    expect(put.url).toContain("/contents/tools/cyberbiz-reports/stores.json");

    const sent = put.body as { message: string; content: string; sha: string; branch: string };
    // 沒帶 sha 的話 GitHub 會當成「建立新檔案」而拒絕。
    expect(sent.sha).toBe("old-sha");
    expect(sent.branch).toBe("main");
    expect(sent.message).toContain("eli@ecotech.tw");
    // 中文店名要能正確還原——btoa 直接吃字串會炸，這裡驗的是有先轉 UTF-8。
    expect(new TextDecoder().decode(Uint8Array.from(atob(sent.content), (ch) => ch.charCodeAt(0))))
      .toContain("乙店");
  });

  it("內容一樣就不留下一筆什麼都沒動的 commit", async () => {
    const calls = stubGithub([{ body: storesFile(TWO_STORES) }]);
    const id = await seedUser("eli@ecotech.tw", "role-admin");

    const response = await as(id, "eli@ecotech.tw", "/api/tools/payout/stores", {
      method: "PUT",
      body: JSON.stringify({ stores: TWO_STORES }),
    });

    expect((await response.json()) as { committed: boolean }).toMatchObject({
      syncedToRepo: true,
      committed: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("儲存顯示開關，但不把平台欄位寫進 runner 的 stores.json", async () => {
    const calls = stubGithub([{ body: storesFile([{ name: "舊的" }]) }, { body: {} }]);
    const id = await seedUser("eli@ecotech.tw", "role-admin");
    const stores = TWO_STORES.map((store, index) => ({ ...store, enabled: index === 0 }));

    const response = await as(id, "eli@ecotech.tw", "/api/tools/payout/stores", {
      method: "PUT",
      body: JSON.stringify({ stores }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { stores: { enabled: boolean }[] }).toMatchObject({
      stores: [{ enabled: true }, { enabled: false }],
    });
    const put = calls[1]!;
    const content = put.body as { content: string };
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(content.content), (ch) => ch.charCodeAt(0)));
    expect(decoded).not.toContain("enabled");
  });

  it("推不上 repo 就整筆不存——不然平台顯示的跟 driver 讀的會不一樣", async () => {
    stubGithub([{ status: 403, body: { message: "no" } }]);
    const id = await seedUser("eli@ecotech.tw", "role-admin");

    const response = await as(id, "eli@ecotech.tw", "/api/tools/payout/stores", {
      method: "PUT",
      body: JSON.stringify({ stores: TWO_STORES }),
    });

    expect(response.status).toBe(502);
    expect(await db().select().from(payoutStores)).toHaveLength(9);
  });

  it("沒接 GitHub 時仍然存本地，但要說得出 repo 沒更新", async () => {
    stubGithub();
    env = { ...env, GITHUB_TOKEN: undefined };
    const id = await seedUser("eli@ecotech.tw", "role-admin");

    const response = await as(id, "eli@ecotech.tw", "/api/tools/payout/stores", {
      method: "PUT",
      body: JSON.stringify({ stores: TWO_STORES }),
    });

    expect((await response.json()) as { syncedToRepo: boolean }).toMatchObject({
      syncedToRepo: false,
      committed: false,
    });
    expect(await db().select().from(payoutStores)).toHaveLength(2);
  });

  it.each([
    ["店名重複", [{ name: "甲店" }, { name: "甲店" }]],
    ["沒填店名", [{ name: "  " }]],
    // 貼錯連結會讓整批檔案上傳到別的地方，跑完才發現就來不及了。
    ["連結不是 Drive 資料夾", [{ name: "甲店", driveFolderUrl: "https://example.com/x" }]],
    ["一家都不留", []],
  ])("擋下不合法的設定（%s）", async (_label, stores) => {
    const calls = stubGithub();
    const id = await seedUser("eli@ecotech.tw", "role-admin");
    const response = await as(id, "eli@ecotech.tw", "/api/tools/payout/stores", {
      method: "PUT",
      body: JSON.stringify({ stores }),
    });
    expect(response.status).toBe(400);

    // 擋下來就不能動到原本的九家，也不該去碰 repo。
    expect(await db().select().from(payoutStores)).toHaveLength(9);
    expect(calls).toHaveLength(0);
  });

  it("主管可以執行但不能改店別設定", async () => {
    stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    expect((await as(id, "manager@ecotech.tw", "/api/tools/payout/state")).status).toBe(200);
    expect(
      (await as(id, "manager@ecotech.tw", "/api/tools/payout/stores", {
        method: "PUT",
        body: JSON.stringify({ stores: [{ name: "甲店" }] }),
      })).status,
    ).toBe(403);
  });
});
