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
async function assignUser(userId: string, employeeNumber: string) {
  const response = await request("/hr/employees", "POST", { userId, employeeNumber, hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01" });
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
    const synced = await (await request("/hr/insurance-rates?year=2026")).json() as { tables: { id: string; scheme: string; status: string }[] };
    expect(synced.tables.filter((table) => table.status === "draft")).toHaveLength(2);
    const laborDraft = synced.tables.find((table) => table.scheme === "labor")!;
    const activated = await request(`/hr/insurance-rates/${laborDraft.id}/activate`, "POST", {});
    expect(activated.status, await activated.clone().text()).toBe(200);
    const afterActivation = await (await request("/hr/insurance-rates?year=2026")).json() as { tables: { scheme: string; status: string; sourceUrl: string }[] };
    expect(afterActivation.tables.find((table) => table.scheme === "labor")?.status).toBe("active");
    expect(afterActivation.tables.find((table) => table.scheme === "health")?.status).toBe("draft");
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const official = await request(`/hr/employments/${profile.employments[0]!.id}/insurance`, "POST", { versions: [
      { scheme: "labor", status: "enrolled", validFrom: "2026-01-01", insuredAmountMinor: 2_950_000, dependentCount: 0, rateYear: 2026, sourceKind: "official", sourceUrl: afterActivation.tables.find((table) => table.scheme === "labor")?.sourceUrl },
    ] });
    expect(official.status, await official.clone().text()).toBe(201);
    expect(synced.tables.filter((table) => table.status === "archived")).toHaveLength(0);
  });

  it("並行同步同一份官方級距只保留一份待審閱版本", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).includes("mol.gov.tw")
      ? new Response(JSON.stringify([{ 身分別: "一般勞工", 投保薪資等級: "1", 月薪資總額: "29500元以下", 月投保薪資: "29500" }]))
      : new Response("組別級距,投保等級,月投保金額（元）,實際薪資月額（元）\n第一組,1,29500,29500元以下\n"));
    const responses = await Promise.all([
      request("/hr/insurance-rates/sync", "POST", { year: 2026 }),
      request("/hr/insurance-rates/sync", "POST", { year: 2026 }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const body = await (await request("/hr/insurance-rates?year=2026")).json() as { tables: { scheme: string; status: string }[] };
    expect(body.tables.filter((table) => table.status === "draft")).toHaveLength(2);
  });

  it("薪資與保險異動以版本保存，薪資更新必須從上一版次日銜接", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-01", payBasis: "monthly", baseAmountMinor: 4000000, items: [{ itemName: "交通津貼", amountMinor: 300000, itemKind: "fixed", includeOvertime: true, includeInsurance: false, includeTax: true }] })).status).toBe(201);
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-03", payBasis: "monthly", baseAmountMinor: 4500000 })).status).toBe(400);
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-02", payBasis: "monthly", baseAmountMinor: 4500000 })).status).toBe(201);
    expect((await request(`/hr/employments/${employmentId}/insurance`, "POST", { versions: [{ scheme: "labor", status: "enrolled", validFrom: "2026-01-01", insuredAmountMinor: 4580000, dependentCount: 0, rateYear: 2026, sourceKind: "manual", note: "測試人工覆核投保金額" }] })).status).toBe(201);
    expect((await request(`/hr/employments/${employmentId}/insurance`, "POST", { versions: [{ scheme: "labor", status: "withdrawn", validFrom: "2026-03-01", insuredAmountMinor: 0, dependentCount: 0, rateYear: 2026, sourceKind: "manual" }] })).status).toBe(201);
    const detail = await (await request("/hr/employees/employee")).json() as { compensation: { baseAmountMinor: number; items?: { itemName: string; includeOvertime: number }[] }[]; insurance: { status: string; validFrom: string; validTo: string | null }[] };
    expect(detail.compensation.find((item) => item.baseAmountMinor === 4000000)?.items).toEqual([expect.objectContaining({ itemName: "交通津貼", includeOvertime: 1 })]);
    expect(detail.compensation).toEqual(expect.arrayContaining([
      expect.objectContaining({ baseAmountMinor: 4500000, validFrom: "2026-01-02", validTo: null }),
      expect.objectContaining({ baseAmountMinor: 4000000, validFrom: "2026-01-01", validTo: "2026-01-02" }),
    ]));
    expect(detail.insurance).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "enrolled", validFrom: "2026-01-01", validTo: "2026-03-01" }),
      expect.objectContaining({ status: "withdrawn", validFrom: "2026-03-01", validTo: null }),
    ]));
  });

  it("最新敘薪可解除並在原生效日建立修正版，歷史列仍保留", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-01", payBasis: "monthly", baseAmountMinor: 4000000 })).status).toBe(201);
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-02", payBasis: "monthly", baseAmountMinor: 4500000 })).status).toBe(201);
    const beforeVoid = await (await request("/hr/employees/employee")).json() as { compensation: Array<{ id: string; validFrom: string; validTo: string | null; baseAmountMinor: number; voidedAt: string | null; voidedBy: string | null }> };
    const latest = beforeVoid.compensation.find((version) => version.baseAmountMinor === 4500000)!;
    const voided = await request(`/hr/employments/${employmentId}/compensation/${latest.id}/void`, "POST", {});
    expect(voided.status, await voided.clone().text()).toBe(200);
    expect((await request(`/hr/employments/${employmentId}/compensation/${latest.id}/void`, "POST", {})).status).toBe(409);
    const afterVoid = await (await request("/hr/employees/employee")).json() as { compensation: Array<{ id: string; validFrom: string; validTo: string | null; baseAmountMinor: number; voidedAt: string | null; voidedBy: string | null }> };
    expect(afterVoid.compensation).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: latest.id, validFrom: "2026-01-02", voidedBy: "admin", voidedAt: expect.any(String) }),
      expect.objectContaining({ baseAmountMinor: 4000000, validFrom: "2026-01-01", validTo: "2026-01-02" }),
    ]));
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-02", payBasis: "monthly", baseAmountMinor: 4600000 })).status).toBe(201);
    const afterReplacement = await (await request("/hr/employees/employee")).json() as { compensation: Array<{ baseAmountMinor: number; validFrom: string; voidedAt: string | null }> };
    expect(afterReplacement.compensation).toEqual(expect.arrayContaining([
      expect.objectContaining({ baseAmountMinor: 4500000, validFrom: "2026-01-02", voidedAt: expect.any(String) }),
      expect.objectContaining({ baseAmountMinor: 4600000, validFrom: "2026-01-02", voidedAt: null }),
    ]));
  });

  it("勞保與健保一起存，任一險別寫不進去時兩邊都不留版本", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const path = `/hr/employments/${profile.employments[0]!.id}/insurance`;
    const labor = (validFrom: string) => ({ scheme: "labor", status: "enrolled", validFrom, insuredAmountMinor: 3_000_000, dependentCount: 0, rateYear: 2026, sourceKind: "manual", note: "測試投保" });
    const health = (validFrom: string) => ({ scheme: "health", status: "enrolled", validFrom, insuredAmountMinor: 3_000_000, dependentCount: 1, rateYear: 2026, sourceKind: "manual", note: "測試投保" });
    const insurance = async () => (await (await request("/hr/employees/employee")).json() as { insurance: { scheme: string; validFrom: string; validTo: string | null }[] }).insurance;

    expect((await request(path, "POST", { versions: [health("2026-01-01")] })).status).toBe(201);
    // 健保在同一天已經有版本，這一筆會期間重疊；勞保不能因為排在前面就先寫進去。
    expect((await request(path, "POST", { versions: [labor("2026-01-01"), health("2026-01-01")] })).status).toBe(409);
    expect((await insurance()).filter((version) => version.scheme === "labor")).toHaveLength(0);

    // 換一個生效日重送，兩個險別都要成功，健保的前一版被關閉。
    expect((await request(path, "POST", { versions: [labor("2026-02-01"), health("2026-02-01")] })).status).toBe(201);
    expect(await insurance()).toEqual(expect.arrayContaining([
      expect.objectContaining({ scheme: "labor", validFrom: "2026-02-01", validTo: null }),
      expect.objectContaining({ scheme: "health", validFrom: "2026-01-01", validTo: "2026-02-01" }),
      expect.objectContaining({ scheme: "health", validFrom: "2026-02-01", validTo: null }),
    ]));
    expect((await request(path, "POST", { versions: [labor("2026-03-01"), labor("2026-03-01")] })).status).toBe(400);
    // Dialog 沒填備註時送的是空字串，不是 undefined；官方級距加保與退保都不需要備註。
    const withdrawn = (scheme: string) => ({ scheme, status: "withdrawn", validFrom: "2026-03-01", insuredAmountMinor: 0, dependentCount: 0, rateYear: 2026, sourceKind: "official", sourceUrl: "", note: "" });
    const blankNote = await request(path, "POST", { versions: [withdrawn("labor"), withdrawn("health")] });
    expect(blankNote.status, await blankNote.clone().text()).toBe(201);
  });

  it("邀請中、還沒登入過平台的員工照樣列入薪資試算", async () => {
    const db = createDatabase(d1 as never);
    await db.insert(users).values({ id: "invited-employee", email: "invited-employee@example.test", displayName: "邀請中員工", status: "invited" });
    await assignUser("invited-employee", "E-INVITED");
    const profile = await (await request("/hr/employees/invited-employee")).json() as { employments: { id: string }[] };
    expect((await request(`/hr/employments/${profile.employments[0]!.id}/compensation`, "POST", { validFrom: "2026-01-01", payBasis: "monthly", baseAmountMinor: 3_000_000 })).status).toBe(201);
    const calculated = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-01", employeeUserIds: ["invited-employee"], requestId: "invited-employee-2026-01" });
    expect(calculated.status, await calculated.clone().text()).toBe(200);
    expect((await calculated.json() as { run: { employees: unknown[] } }).run.employees).toHaveLength(1);
  });

  it("部分結算只在所有啟用員工 claim 完成後關閉薪資期間", async () => {
    const db = createDatabase(d1 as never);
    await db.insert(users).values({ id: "employee-two", email: "employee-two@example.test", displayName: "第二位員工", status: "active" });
    await assign();
    await assignUser("employee-two", "E-PAY-2");
    const firstProfile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const secondProfile = await (await request("/hr/employees/employee-two")).json() as { employments: { id: string }[] };
    for (const employmentId of [firstProfile.employments[0]!.id, secondProfile.employments[0]!.id]) {
      expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-01", payBasis: "monthly", baseAmountMinor: 3_000_000 })).status).toBe(201);
    }
    const first = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-01", employeeUserIds: ["employee"], requestId: "partial-close-first" });
    expect(first.status, await first.clone().text()).toBe(200);
    const firstRunId = (await first.json() as { run: { runId: string } }).run.runId;
    const concurrentClose = await Promise.all([
      request(`/hr/payroll/runs/${firstRunId}/close`, "POST", {}),
      request(`/hr/payroll/runs/${firstRunId}/close`, "POST", {}),
    ]);
    expect(concurrentClose.map((response) => response.status).sort()).toEqual([200, 409]);
    const afterFirst = await (await request("/hr/payroll/runs")).json() as { runs: Array<{ run: { requestId: string; status: string }; periodStatus: string }> };
    expect(afterFirst.runs.find((item) => item.run.requestId === "partial-close-first")).toMatchObject({ run: { status: "closed" }, periodStatus: "open" });

    const second = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-01", employeeUserIds: ["employee-two"], requestId: "partial-close-second" });
    expect(second.status, await second.clone().text()).toBe(200);
    const secondRunId = (await second.json() as { run: { runId: string } }).run.runId;
    expect((await request(`/hr/payroll/runs/${secondRunId}/close`, "POST", {})).status).toBe(200);
    const afterSecond = await (await request("/hr/payroll/runs")).json() as { runs: Array<{ run: { requestId: string; status: string }; periodStatus: string }> };
    expect(afterSecond.runs.find((item) => item.run.requestId === "partial-close-second")).toMatchObject({ run: { status: "closed" }, periodStatus: "closed" });
    expect((await request("/hr/payroll/calculate", "POST", { periodKey: "2026-01", employeeUserIds: ["employee"], requestId: "partial-close-after" })).status).toBe(409);
  });

  it("來源快照變更時不能直接結帳舊試算", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-01", payBasis: "monthly", baseAmountMinor: 3_000_000 })).status).toBe(201);
    const calculated = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-01", employeeUserIds: ["employee"], requestId: "stale-source-test" });
    expect(calculated.status, await calculated.clone().text()).toBe(200);
    const runId = (await calculated.json() as { run: { runId: string } }).run.runId;
    const leaveType = await request("/hr/payroll/monthly-data/leave-types", "POST", { name: "測試無薪假", defaultPayRatePpm: 0 });
    expect(leaveType.status, await leaveType.clone().text()).toBe(201);
    const leaveTypeId = (await leaveType.json() as { id: string }).id;
    const leave = await request("/hr/payroll/monthly-data/leave", "POST", { employmentId, leaveTypeId, leaveDate: "2026-01-05", hoursHalfUnits: 16, payRatePpm: 0, deductionAmount: 1000, note: "試算後新增" });
    expect(leave.status, await leave.clone().text()).toBe(201);
    const close = await request(`/hr/payroll/runs/${runId}/close`, "POST", {});
    expect(close.status, await close.clone().text()).toBe(409);
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
    expect((await request(`/hr/employments/${employmentId}/insurance`, "POST", { versions: [{ scheme: "labor", status: "enrolled", validFrom: "2026-01-01", insuredAmountMinor: 3000000, dependentCount: 0, rateYear: 2026, sourceKind: "manual", note: "測試投保" }] })).status).toBe(201);
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
