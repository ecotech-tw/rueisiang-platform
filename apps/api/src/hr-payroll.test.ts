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
    expect((await request("/hr/insurance-rates/sync", "POST", { year: 2026 })).status).toBe(201);
    expect((await request("/hr/insurance-rates/sync", "POST", { year: 2026 })).status).toBe(201);
    const synced = await (await request("/hr/insurance-rates?year=2026")).json() as { tables: { status: string }[] };
    expect(synced.tables.filter((table) => table.status === "draft")).toHaveLength(2);
    expect(synced.tables.filter((table) => table.status === "archived")).toHaveLength(0);
  });

  it("薪資與保險異動以版本保存，新增加保會關閉前一個開放版本", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-01", payBasis: "monthly", baseAmountMinor: 4000000, items: [{ itemName: "交通津貼", amountMinor: 300000, itemKind: "fixed", includeOvertime: true, includeInsurance: false, includeTax: true }] })).status).toBe(201);
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-03-01", payBasis: "monthly", baseAmountMinor: 4500000 })).status).toBe(201);
    expect((await request(`/hr/employments/${employmentId}/insurance`, "POST", { scheme: "labor", status: "enrolled", validFrom: "2026-01-01", insuredAmountMinor: 4580000, dependentCount: 0, rateYear: 2026, sourceKind: "official", sourceUrl: "https://apiservice.mol.gov.tw/" })).status).toBe(201);
    expect((await request(`/hr/employments/${employmentId}/insurance`, "POST", { scheme: "labor", status: "withdrawn", validFrom: "2026-03-01", insuredAmountMinor: 0, dependentCount: 0, rateYear: 2026, sourceKind: "manual" })).status).toBe(201);
    const detail = await (await request("/hr/employees/employee")).json() as { compensation: { baseAmountMinor: number; items?: { itemName: string; includeOvertime: number }[] }[]; insurance: { status: string; validFrom: string; validTo: string | null }[] };
    expect(detail.compensation.find((item) => item.baseAmountMinor === 4000000)?.items).toEqual([expect.objectContaining({ itemName: "交通津貼", includeOvertime: 1 })]);
    expect(detail.compensation).toEqual(expect.arrayContaining([
      expect.objectContaining({ baseAmountMinor: 4500000, validFrom: "2026-03-01", validTo: null }),
      expect.objectContaining({ baseAmountMinor: 4000000, validFrom: "2026-01-01", validTo: "2026-03-01" }),
    ]));
    expect(detail.insurance).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "enrolled", validFrom: "2026-01-01", validTo: "2026-03-01" }),
      expect.objectContaining({ status: "withdrawn", validFrom: "2026-03-01", validTo: null }),
    ]));
  });

  it("特殊上班日保存規則版本快照，允許零補貼且阻擋重複套用", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    const created = await request("/hr/special-workdays/rules", "POST", { name: "測試國定日", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, overtimeRule: "不自動核准加班", allowances: [{ itemName: "餐費", unitAmountMinor: 0 }, { itemName: "交通補貼", unitAmountMinor: 12000 }] });
    expect(created.status, await created.clone().text()).toBe(201);
    const createdBody = await created.json() as { versionId: string };
    const listed = await (await request("/hr/special-workdays/rules")).json() as { rules: Array<{ rule: { name: string }; versions: Array<{ id: string; workSource: string; note: string; allowances: Array<{ itemName: string; unitAmountMinor: number }> }> }> };
    expect(listed.rules).toEqual(expect.arrayContaining([expect.objectContaining({ rule: expect.objectContaining({ name: "測試國定日" }), versions: [expect.objectContaining({ id: createdBody.versionId, workSource: "hourly", note: "", allowances: [expect.objectContaining({ itemName: "餐費", unitAmountMinor: 0 }), expect.objectContaining({ itemName: "交通補貼", unitAmountMinor: 12000 })] })] })]));
    const assigned = await request("/hr/special-workdays/assignments", "POST", { ruleVersionId: createdBody.versionId, assignments: [{ employmentId, workDate: "2026-02-28", allowanceQuantity: 0 }] });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    expect((await request("/hr/special-workdays/assignments?start=2026-02-01&end=2026-03-01")).status).toBe(200);
    expect((await request("/hr/special-workdays/assignments", "POST", { ruleVersionId: createdBody.versionId, assignments: [{ employmentId, workDate: "2026-02-28", allowanceQuantity: 0 }] })).status).toBe(409);
  });

  it("公司負擔規則會進入薪資扣款，結帳後同員工月份改用薪資調整", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-01", payBasis: "monthly", baseAmountMinor: 4000000 })).status).toBe(201);
    expect((await request("/hr/insurance-contribution-rules", "POST", { scheme: "labor", validFrom: "2026-01-01", employeeRatePpm: 10000, employerRatePpm: 20000, dependentRatePpm: 1000000, sourceKind: "manual", note: "測試公司規則" })).status).toBe(201);
    expect((await request(`/hr/employments/${employmentId}/insurance`, "POST", { scheme: "labor", status: "enrolled", validFrom: "2026-01-01", insuredAmountMinor: 3000000, dependentCount: 0, rateYear: 2026, sourceKind: "manual", note: "測試投保" })).status).toBe(201);
    const calculated = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-01", employeeUserIds: ["employee"], requestId: "close-test-2026-01" });
    expect(calculated.status, await calculated.clone().text()).toBe(200);
    const result = await calculated.json() as { run: { runId: string; warnings: string[]; employees: Array<{ lines: Array<{ lineKey: string; amountMinor: number }> }> } };
    expect(result.run.warnings).not.toContain("本版未計算勞健保扣款：需先設定公司採用的費率與負擔規則。");
    expect(result.run.employees[0]?.lines).toEqual(expect.arrayContaining([expect.objectContaining({ lineKey: "labor_insurance", amountMinor: 30000 })]));
    const closed = await request(`/hr/payroll/runs/${result.run.runId}/close`, "POST", {});
    expect(closed.status, await closed.clone().text()).toBe(200);
    expect((await request("/hr/payroll/calculate", "POST", { periodKey: "2026-01", employeeUserIds: ["employee"], requestId: "close-test-2026-01-repeat" })).status).toBe(409);
    const adjustment = await request("/hr/payroll/adjustments", "POST", { employmentId, sourcePeriodKey: "2026-01", effectivePeriodKey: "2026-02", reason: "結帳後補發", items: [{ itemName: "補發", amountMinor: 50000 }] });
    expect(adjustment.status, await adjustment.clone().text()).toBe(201);
  });
});
