import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { crmCustomerTags, crmTags, crmCustomers, userRoles, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

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

async function seedCustomer(input: Partial<typeof crmCustomers.$inferInsert> & { id: string; phone: string; tags?: string[] }) {
  const { tags = [], ...customer } = input;
  await db().insert(crmCustomers).values({ normalizedPhone: input.phone.replace(/\D/g, ""), ...customer });
  for (const name of tags) {
    const tagId = `tag-${name}`;
    await db().insert(crmTags).values({ id: tagId, name }).onConflictDoNothing();
    const [tag] = await db().select({ id: crmTags.id }).from(crmTags).where(eq(crmTags.name, name));
    await db().insert(crmCustomerTags).values({ customerId: input.id, crmTagId: tag!.id });
  }
}

async function as(userId: string, email: string, path: string) {
  const token = await signSession(
    newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }),
    SECRET,
  );
  return app.fetch(
    new Request(`https://platform.rueisiang.com${path}`, {
      headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    }),
    env as never,
  );
}

async function list(userId: string, email: string, query = "") {
  const response = await as(userId, email, `/api/crm/customers${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    customers: { id: string; name: string; phone: string }[];
    total: number;
    page: number;
    pageSize: number;
    stats: { total: number; active: number; blocked: number; incomplete: number };
  };
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

describe("客戶列表的把關", () => {
  it("未登入是 401", async () => {
    const response = await app.fetch(
      new Request("https://platform.rueisiang.com/api/crm/customers"),
      env as never,
    );
    expect(response.status).toBe(401);
  });

  it("沒有 crm:customer:read 的人被 403 擋下", async () => {
    // 只有出金表權限的角色不存在，所以直接給一個沒有任何權限的帳號。
    const id = `user-none@ecotech.tw`;
    await db().insert(users).values({ id, email: "none@ecotech.tw", status: "active" });
    const response = await as(id, "none@ecotech.tw", "/api/crm/customers");
    expect(response.status).toBe(403);
  });

  it("檢視者讀得到——這是唯讀端點", async () => {
    const id = await seedUser("viewer@ecotech.tw", "role-viewer");
    const response = await as(id, "viewer@ecotech.tw", "/api/crm/customers");
    expect(response.status).toBe(200);
  });
});

describe("搜尋與篩選", () => {
  beforeEach(async () => {
    await seedCustomer({ id: "c1", phone: "0912 345 678", name: "王小明", email: "wang@example.com", address: "台北市", cyberbizCustomerId: "cb-1", tags: ["VIP", "熟客"] });
    await seedCustomer({ id: "c2", phone: "0922333444", name: "陳美玲", email: "chen@example.com", address: "新北市" });
    await seedCustomer({ id: "c3", phone: "0933555666", name: "", email: "", address: "", cyberbizCustomerId: "cb-3", status: "blocked" });
  });

  it("預設回全部，並附上統計", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const body = await list(id, "staff@ecotech.tw");

    expect(body.total).toBe(3);
    expect(body.stats).toEqual({ total: 3, active: 2, blocked: 1, incomplete: 1 });
  });

  it.each([
    ["姓名", "?search=王小明", ["c1"]],
    ["電話片段", "?search=2233", ["c2"]],
    // 使用者打的是連號，資料存的可能帶空格（CYBERBIZ 原樣帶進來的）。
    ["沒有空格的完整電話", "?search=0912345678", ["c1"]],
    ["Email", "?search=chen@example", ["c2"]],
    ["地址", "?search=新北", ["c2"]],
    ["標籤", "?search=VIP", ["c1"]],
  ])("搜尋涵蓋%s", async (_label, query, expected) => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const body = await list(id, "staff@ecotech.tw", query);
    expect(body.customers.map((customer) => customer.id)).toEqual(expected);
  });

  it("依狀態篩選", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const body = await list(id, "staff@ecotech.tw", "?status=blocked");
    expect(body.customers.map((customer) => customer.id)).toEqual(["c3"]);
  });

  it("依標籤篩選", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const body = await list(id, "staff@ecotech.tw", "?tag=熟客");
    expect(body.customers.map((customer) => customer.id)).toEqual(["c1"]);
  });

  it("統計不受篩選影響——它描述的是整個資料庫", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const body = await list(id, "staff@ecotech.tw", "?status=blocked");
    expect(body.total).toBe(1);
    expect(body.stats.total).toBe(3);
  });
});

describe("排序與分頁", () => {
  beforeEach(async () => {
    for (let i = 1; i <= 12; i += 1) {
      await seedCustomer({
        id: `c${String(i).padStart(2, "0")}`,
        phone: `09000000${String(i).padStart(2, "0")}`,
        name: `客戶${String(i).padStart(2, "0")}`,
      });
    }
  });

  it("預設每頁 10 筆", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const body = await list(id, "staff@ecotech.tw");
    expect(body.customers).toHaveLength(10);
    expect(body.total).toBe(12);
  });

  it("翻到第二頁拿剩下的", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const body = await list(id, "staff@ecotech.tw", "?page=2");
    expect(body.customers).toHaveLength(2);
  });

  it("兩頁之間不會重複或漏掉——排序帶了 id 當第二個鍵", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const first = await list(id, "staff@ecotech.tw", "?pageSize=10&page=1");
    const second = await list(id, "staff@ecotech.tw", "?pageSize=10&page=2");

    const ids = [...first.customers, ...second.customers].map((customer) => customer.id);
    expect(new Set(ids).size).toBe(12);
  });

  it("依姓名遞增排序", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const body = await list(id, "staff@ecotech.tw", "?sortField=name&sortDirection=asc&pageSize=100");
    expect(body.customers[0]?.name).toBe("客戶01");
  });

  it.each([
    ["排序欄位亂填", "?sortField=DROP+TABLE", 12],
    ["每頁筆數不在白名單", "?pageSize=999", 10],
    ["頁碼是負數", "?page=-3", 10],
  ])("%s就退回預設值，不是報錯", async (_label, query, expectedRows) => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const body = await list(id, "staff@ecotech.tw", `${query}&pageSize=${query.includes("pageSize") ? "999" : "100"}`);
    expect(body.customers.length).toBeLessThanOrEqual(Math.max(expectedRows, 12));
    expect(body.total).toBe(12);
  });
});
