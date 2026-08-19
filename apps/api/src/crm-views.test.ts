import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { userRoles, users } from "@rueisiang/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

/**
 * 儲存的檢視。重點在於「存進去的東西一定跑得起來」——這些條件會直接變成
 * 客戶列表的查詢，讓一筆亂寫的檢視把列表頁弄壞是最不能接受的。
 */

const SECRET = "test-secret";
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

interface ViewRow {
  id: string;
  name: string;
  search: string;
  channel: string;
  status: string;
  tag: string;
  sortField: string;
  sortDirection: string;
  pageSize: number;
  createdByEmail: string;
}

async function listViews(userId: string, email: string): Promise<ViewRow[]> {
  const response = await as(userId, email, "/api/crm/views");
  return ((await response.json()) as { views: ViewRow[] }).views;
}

beforeEach(async () => {
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  };
  await syncSystemRoles(db());
});

describe("儲存檢視", () => {
  it("存下整組條件，並記下是誰建的", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const response = await as(id, "staff@ecotech.tw", "/api/crm/views", {
      method: "POST",
      body: JSON.stringify({
        name: "待補地址的客人",
        search: "台北",
        channel: "cyberbiz",
        status: "active",
        tag: "VIP",
        sortField: "name",
        sortDirection: "asc",
        pageSize: 50,
      }),
    });
    expect(response.status).toBe(201);

    const [view] = await listViews(id, "staff@ecotech.tw");
    expect(view).toMatchObject({
      name: "待補地址的客人",
      search: "台北",
      channel: "cyberbiz",
      status: "active",
      tag: "VIP",
      sortField: "name",
      sortDirection: "asc",
      pageSize: 50,
      createdByEmail: "staff@ecotech.tw",
    });
  });

  it("不認得的條件退回預設值，不是存進去或報錯", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    await as(id, "staff@ecotech.tw", "/api/crm/views", {
      method: "POST",
      body: JSON.stringify({
        name: "亂寫的",
        channel: "蝦皮",
        status: "刪除",
        // 排序欄位可能是舊版本存下來的；每頁 999 筆會把 Worker 撐爆。
        sortField: "'; drop table customers; --",
        pageSize: 999,
      }),
    });

    const [view] = await listViews(id, "staff@ecotech.tw");
    expect(view).toMatchObject({
      channel: "all",
      status: "all",
      tag: "all",
      sortField: "updatedAt",
      sortDirection: "desc",
      pageSize: 10,
    });
  });

  it("存下的檢視拿去查詢真的跑得起來", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    await as(id, "staff@ecotech.tw", "/api/crm/views", {
      method: "POST",
      body: JSON.stringify({ name: "封鎖名單", status: "blocked", sortField: "name", pageSize: 25 }),
    });

    const [view] = await listViews(id, "staff@ecotech.tw");
    const params = new URLSearchParams({
      search: view!.search,
      channel: view!.channel,
      status: view!.status,
      tag: view!.tag,
      sortField: view!.sortField,
      sortDirection: view!.sortDirection,
      pageSize: String(view!.pageSize),
    });
    const response = await as(id, "staff@ecotech.tw", `/api/crm/customers?${params}`);
    expect(response.status).toBe(200);
    expect((await response.json()) as { pageSize: number }).toMatchObject({ pageSize: 25 });
  });

  it("同名的檢視不會建立兩次", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const payload = JSON.stringify({ name: "重複" });
    expect((await as(id, "staff@ecotech.tw", "/api/crm/views", { method: "POST", body: payload })).status).toBe(201);
    expect((await as(id, "staff@ecotech.tw", "/api/crm/views", { method: "POST", body: payload })).status).toBe(409);
  });

  it("沒填名稱擋下來", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const response = await as(id, "staff@ecotech.tw", "/api/crm/views", {
      method: "POST",
      body: JSON.stringify({ name: "   " }),
    });
    expect(response.status).toBe(400);
  });
});

describe("套用與刪除", () => {
  async function seedView(userId: string, email: string, name: string) {
    const response = await as(userId, email, "/api/crm/views", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return ((await response.json()) as { id: string }).id;
  }

  it("檢視是共用的，別人建的自己也看得到", async () => {
    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    await seedView(manager, "manager@ecotech.tw", "主管建的");

    const viewer = await seedUser("viewer@ecotech.tw", "role-viewer");
    const views = await listViews(viewer, "viewer@ecotech.tw");
    expect(views.map((view) => view.name)).toEqual(["主管建的"]);
  });

  it("檢視者看得到但不能建立，也不能刪除", async () => {
    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    const viewId = await seedView(manager, "manager@ecotech.tw", "主管建的");

    const viewer = await seedUser("viewer@ecotech.tw", "role-viewer");
    expect(
      (await as(viewer, "viewer@ecotech.tw", "/api/crm/views", {
        method: "POST",
        body: JSON.stringify({ name: "檢視者建的" }),
      })).status,
    ).toBe(403);
    expect(
      (await as(viewer, "viewer@ecotech.tw", `/api/crm/views/${viewId}`, { method: "DELETE" })).status,
    ).toBe(403);
  });

  it("刪掉之後就不在列表裡", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const viewId = await seedView(id, "staff@ecotech.tw", "先建再刪");

    expect((await as(id, "staff@ecotech.tw", `/api/crm/views/${viewId}`, { method: "DELETE" })).status).toBe(200);
    expect(await listViews(id, "staff@ecotech.tw")).toHaveLength(0);
  });

  it("刪不存在的檢視回 404，不是默默成功", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const response = await as(id, "staff@ecotech.tw", "/api/crm/views/不存在", { method: "DELETE" });
    expect(response.status).toBe(404);
  });

  it("沒登入的人讀不到", async () => {
    const response = await app.fetch(
      new Request("https://platform.rueisiang.com/api/crm/views"),
      env as never,
    );
    expect(response.status).toBe(401);
  });
});
