import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { userRoleAssignments, users } from "@rueisiang/db/schema";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "hr-payroll-test-secret-test-secret";
let d1: LocalD1;
let cookies: Record<string, string>;

async function request(path: string, method = "GET", payload?: Record<string, unknown>) {
  return app.fetch(new Request(`https://test.local/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookies.admin ?? "" },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  }), { DB: d1, AUTH_SESSION_SECRET: SECRET, GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" } as never);
}
async function assign() {
  const response = await request("/hr/employees", "POST", { userId: "employee", employeeNumber: "E-PAY", hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01" });
  expect(response.status, await response.clone().text()).toBe(201);
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  const db = createDatabase(d1 as never);
  await syncSystemRoles(db);
  await db.insert(users).values([
    { id: "admin", email: "admin@example.test", displayName: "管理者", status: "active" },
    { id: "employee", email: "employee@example.test", displayName: "員工", status: "active" },
  ]);
  await db.insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  cookies = { admin: `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id: "admin", email: "admin@example.test", name: "管理者", pictureUrl: "" }), SECRET))}` };
});
afterEach(() => { vi.restoreAllMocks(); d1.sqlite.close(); });

describe("HR 薪資與勞健保", () => {
  it("從兩個官方開放資料來源解析勞保與健保級距", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("mol.gov.tw")) return new Response(JSON.stringify([
        { 身分別: "一般勞工", 投保薪資等級: "1", 月薪資總額: "29500元以下", 月投保薪資: "29500" },
        { 身分別: "一般勞工", 投保薪資等級: "2", 月薪資總額: "29501元至30300元", 月投保薪資: "30300" },
      ]));
      return new Response("組別級距,投保等級,月投保金額（元）,實際薪資月額（元）\n第一組,1,29500,29500元以下\n第二組,2,30300,29501-30300\n");
    });
    const response = await request("/hr/insurance-brackets?year=2026");
    expect(response.status).toBe(200);
    const body = await response.json() as { tables: { scheme: string; brackets: { insuredAmount: number; lowerSalary: number }[]; sourceUrl: string }[] };
    expect(body.tables).toHaveLength(2);
    expect(body.tables.find((table) => table.scheme === "labor")?.brackets[1]).toMatchObject({ insuredAmount: 30300, lowerSalary: 29501 });
    expect(body.tables.find((table) => table.scheme === "health")?.brackets[0]).toMatchObject({ insuredAmount: 29500, lowerSalary: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("薪資與保險異動以版本保存，新增加保會關閉前一個開放版本", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-01", payBasis: "monthly", baseAmountMinor: 4000000 })).status).toBe(201);
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-03-01", payBasis: "monthly", baseAmountMinor: 4500000 })).status).toBe(201);
    expect((await request(`/hr/employments/${employmentId}/insurance`, "POST", { scheme: "labor", status: "enrolled", validFrom: "2026-01-01", insuredAmountMinor: 4580000, dependentCount: 0, rateYear: 2026, sourceKind: "official", sourceUrl: "https://apiservice.mol.gov.tw/" })).status).toBe(201);
    expect((await request(`/hr/employments/${employmentId}/insurance`, "POST", { scheme: "labor", status: "withdrawn", validFrom: "2026-03-01", insuredAmountMinor: 0, dependentCount: 0, rateYear: 2026, sourceKind: "manual" })).status).toBe(201);
    const detail = await (await request("/hr/employees/employee")).json() as { compensation: { baseAmountMinor: number }[]; insurance: { status: string; validFrom: string; validTo: string | null }[] };
    expect(detail.compensation).toEqual(expect.arrayContaining([
      expect.objectContaining({ baseAmountMinor: 4500000, validFrom: "2026-03-01", validTo: null }),
      expect.objectContaining({ baseAmountMinor: 4000000, validFrom: "2026-01-01", validTo: "2026-03-01" }),
    ]));
    expect(detail.insurance).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "enrolled", validFrom: "2026-01-01", validTo: "2026-03-01" }),
      expect.objectContaining({ status: "withdrawn", validFrom: "2026-03-01", validTo: null }),
    ]));
  });
});
