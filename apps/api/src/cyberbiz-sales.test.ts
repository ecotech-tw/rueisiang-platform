import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, listCyberbizReportRuns, listPayoutStores, seedPayoutStores, syncSystemRoles } from "@rueisiang/db";
import { userRoles, users } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "test-secret";
const RANGE = { start: "2026-07-01", end: "2026-07-31" };

let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
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

function stubGithub() {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(null, { status: 204 });
  });
  return calls;
}

beforeEach(async () => {
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    GITHUB_TOKEN: "gh-token",
    PAYOUT_GITHUB_REPO: "ecotech-tw/rueisiang-platform",
    PAYOUT_WORKFLOW_FILE: "payout.yml",
    CYBERBIZ_SALES_WORKFLOW_FILE: "cyberbiz-sales-report.yml",
    CYBERBIZ_SALES_GITHUB_REF: "main",
  };
  await syncSystemRoles(db());
  await seedPayoutStores(db());
});

afterEach(() => vi.unstubAllGlobals());

describe("CYBERBIZ 商品銷售報表執行", () => {
  it("完整月份可由主管執行，並留下可進 manifest 的 audit record", async () => {
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const stores = await listPayoutStores(db());
    const names = stores.map((store) => store.name);

    const response = await as(id, "manager@ecotech.tw", "/api/tools/cyberbiz-sales/run", {
      method: "POST",
      body: JSON.stringify({ stores: names, ...RANGE }),
    });

    expect(response.status).toBe(202);
    expect(calls[0]).toMatchObject({
      url: expect.stringContaining("/actions/workflows/cyberbiz-sales-report.yml/dispatches"),
      body: {
        ref: "main",
        inputs: { store: "全部", start: RANGE.start, end: RANGE.end },
      },
    });
    const [run] = await listCyberbizReportRuns(db(), "sales");
    expect(run).toMatchObject({ periodKind: "month", manifestEligible: 1, storesJson: JSON.stringify(names) });
  });

  it("自訂區間只記錄 Drive-only，不能讓它變成 AI manifest", async () => {
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const store = (await listPayoutStores(db()))[0]!;
    const response = await as(id, "manager@ecotech.tw", "/api/tools/cyberbiz-sales/run", {
      method: "POST",
      body: JSON.stringify({ stores: [store.name], start: "2026-07-14", end: "2026-07-18" }),
    });

    expect(response.status).toBe(202);
    expect(calls[0]?.body).toMatchObject({ inputs: { store: store.name, start: "2026-07-14", end: "2026-07-18" } });
    const [run] = await listCyberbizReportRuns(db(), "sales");
    expect(run).toMatchObject({ periodKind: "custom", manifestEligible: 0 });
  });

  it("沒有商品銷售執行權限的人不能看到狀態或觸發 workflow", async () => {
    stubGithub();
    const id = await seedUser("viewer@ecotech.tw", "role-viewer");
    const response = await as(id, "viewer@ecotech.tw", "/api/tools/cyberbiz-sales/state");
    expect(response.status).toBe(403);
  });

  it("未設定 workflow 時回傳可理解的服務未設定狀態", async () => {
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    env = { ...env, CYBERBIZ_SALES_WORKFLOW_FILE: undefined };
    const response = await as(id, "manager@ecotech.tw", "/api/tools/cyberbiz-sales/state");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: false });
  });

  it("sales repository 分開設定時，店別設定仍同步到兩個 repository", async () => {
    const calls = stubGithub();
    env = { ...env, CYBERBIZ_SALES_GITHUB_REPO: "ecotech-tw/report-runner", CYBERBIZ_SALES_GITHUB_REF: "release" };
    const id = await seedUser("admin@ecotech.tw", "role-admin");
    const response = await as(id, "admin@ecotech.tw", "/api/tools/payout/stores", {
      method: "PUT",
      body: JSON.stringify({ stores: [{ name: "新店", driveFolderUrl: "https://drive.google.com/drive/folders/folder-id", driveFolderName: "新店" }] }),
    });

    expect(response.status).toBe(200);
    const writes = calls.filter((call) => call.url.includes("/contents/tools/cyberbiz-reports/stores.json"));
    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining("/repos/ecotech-tw/rueisiang-platform/"), body: expect.objectContaining({ branch: "main" }) }),
      expect.objectContaining({ url: expect.stringContaining("/repos/ecotech-tw/report-runner/"), body: expect.objectContaining({ branch: "release" }) }),
    ]));
  });

  it("商品銷售執行收到 null body 時回傳 400", async () => {
    stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const response = await as(id, "manager@ecotech.tw", "/api/tools/cyberbiz-sales/run", {
      method: "POST",
      body: "null",
    });

    expect(response.status).toBe(400);
  });
});
