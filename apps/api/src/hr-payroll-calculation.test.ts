import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, listHrBonusPools } from "@rueisiang/db";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";
import { seedDevData } from "./dev/fixtures.js";

const SECRET = "hr-payroll-calculation-test-secret";
let d1: LocalD1;
let cookie: string;

async function request(path: string, method = "GET", payload?: unknown) {
  return app.fetch(new Request(`https://test.local/api${path}`, {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }), {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "test",
    GOOGLE_OAUTH_CLIENT_SECRET: "test",
  } as never);
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  await seedDevData(d1);
  cookie = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id: "dev-eli-lin@ecotech.tw", email: "eli-lin@ecotech.tw", name: "林瑞翔", pictureUrl: "" }), SECRET))}`;
});
afterEach(() => d1.sqlite.close());

describe("HR 薪資與櫃點獎金試算", () => {
  it("使用林瑞翔的假勤與加班紀錄建立辦公室薪資單", async () => {
    const invalidScope = await request("/hr/bonus/policies", "POST", { name: "不存在通路", scopeId: "missing-scope", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 50_000, guaranteeMinor: 0 });
    expect(invalidScope.status, await invalidScope.clone().text()).toBe(404);
    const policyResponse = await request("/hr/bonus/policies", "POST", { name: "林瑞翔無業績測試", scopeId: "cyberbiz:store:demo-xinyi", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 50_000, guaranteeMinor: 0, employeeUserIds: ["dev-eli-lin@ecotech.tw"], assignmentValidFrom: "2026-01-01" });
    expect(policyResponse.status, await policyResponse.clone().text()).toBe(201);
    const response = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08",
      attendanceMode: "general",
      employeeUserIds: ["dev-eli-lin@ecotech.tw"],
      requestId: "test-payroll-2026-08-lin",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { run: { runId: string; status: string; warnings: string[]; employees: Array<{ employeeName: string; earningMinor: number; deductionMinor: number; netMinor: number; lines: Array<{ lineKey: string; amountMinor: number }> }> } };
    expect(body.run.status).toBe("ready");
    expect(body.run.warnings).toContain("本版未計算勞健保扣款：需先設定公司採用的費率與負擔規則。");
    expect(body.run.warnings.some((warning) => warning.includes("林瑞翔") && warning.includes("找不到當月業績快照"))).toBe(true);
    expect(body.run.employees[0]).toMatchObject({ employeeUserId: "dev-eli-lin@ecotech.tw", employeeName: "林瑞翔", earningMinor: 6_116_665, deductionMinor: 193_548, netMinor: 5_923_117 });
    expect(body.run.employees[0]!.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineKey: "base_salary", amountMinor: 6_000_000 }),
      expect.objectContaining({ lineKey: "overtime", amountMinor: 116_665 }),
      expect.objectContaining({ lineKey: "unpaid_leave", amountMinor: 193_548 }),
    ]));
    const repeat = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-08", attendanceMode: "general", employeeUserIds: ["dev-eli-lin@ecotech.tw"], requestId: "test-payroll-2026-08-lin" });
    expect((await repeat.json() as { run: { runId: string } }).run.runId).toBe(body.run.runId);
  });

  it("按員工套用的 policy 自動計算櫃位業績獎金並四捨五入到元", async () => {
    const response = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08", attendanceMode: "scheduled", employeeUserIds: ["dev-wang@ecotech.tw"], requestId: "test-payroll-2026-08-wang",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as {
      run: {
        employees: Array<{
          employeeUserId: string;
          lines: Array<{ lineKey: string; amountMinor: number; explanation: Record<string, unknown> }>;
        }>;
      };
    };
    const employee = body.run.employees[0]!;
    expect(employee.employeeUserId).toBe("dev-wang@ecotech.tw");
    expect(employee.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineKey: "bonus_1", amountMinor: 150_000, explanation: expect.objectContaining({ bonusKind: "team_performance", performancePeriod: "current_month", rounding: "nearest_ntd_dollar" }) }),
    ]));
  });

  it("同一員工可套用多筆 policy，計薪時合併自動獎金", async () => {
    const created = await request("/hr/bonus/policies", "POST", {
      name: "測試團體績效", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 33_333, guaranteeMinor: 0, employeeUserIds: ["dev-wang@ecotech.tw"], assignmentValidFrom: "2026-01-01",
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const createdBody = await created.json() as { policyVersionId: string };
    expect((await request(`/hr/bonus/policies/${createdBody.policyVersionId}/members`, "POST", { employeeUserId: "dev-wang@ecotech.tw", validFrom: "2026-01-01" })).status).toBe(409);
    const individual = await request("/hr/bonus/policies", "POST", {
      name: "測試個人績效", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "individual_performance", performancePeriod: "current_month", ratePpm: 10_000, guaranteeMinor: 0,
    });
    expect(individual.status, await individual.clone().text()).toBe(201);
    const individualBody = await individual.json() as { policyVersionId: string };
    expect((await request(`/hr/bonus/policies/${individualBody.policyVersionId}/members`, "POST", { employeeUserId: "dev-wang@ecotech.tw", validFrom: "2026-01-01" })).status).toBe(201);
    expect((await request("/hr/bonus/performance", "POST", { scopeId: "cyberbiz:store:demo-ximen", employeeUserId: "dev-wang@ecotech.tw", periodKey: "2026-08", amountMinor: 1_234_567, sourceKind: "manual", sourceRef: "test-wang-individual" })).status).toBe(201);
    expect((await request("/hr/bonus/pools/calculate", "POST", { policyVersionId: individualBody.policyVersionId, periodKey: "2026-08", revenue: [] })).status).toBe(400);
    const payroll = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-08", attendanceMode: "scheduled", employeeUserIds: ["dev-wang@ecotech.tw"], requestId: "test-payroll-2026-08-wang-multiple" });
    expect(payroll.status, await payroll.clone().text()).toBe(200);
    const body = await payroll.json() as { run: { employees: Array<{ lines: Array<{ amountMinor: number; explanation: Record<string, unknown> }> }> } };
    const lines = body.run.employees[0]!.lines;
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ amountMinor: 150_000, explanation: expect.objectContaining({ bonusKind: "team_performance" }) }),
      expect.objectContaining({ amountMinor: 12_300, explanation: expect.objectContaining({ bonusKind: "individual_performance" }) }),
    ]));
    const teamSnapshot = { scopeId: "cyberbiz:store:demo-ximen", periodKey: "2026-09", amountMinor: 100_000, sourceKind: "report", sourceRef: "team-duplicate" };
    expect((await request("/hr/bonus/performance", "POST", teamSnapshot)).status).toBe(201);
    expect((await request("/hr/bonus/performance", "POST", teamSnapshot)).status).toBe(409);
  });

  it("policy 可以編輯並保留舊版本", async () => {
    const created = await request("/hr/bonus/policies", "POST", { name: "可編輯 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 20_000, guaranteeMinor: 0, employeeUserIds: ["dev-wang@ecotech.tw"], assignmentValidFrom: "2026-01-01" });
    expect(created.status, await created.clone().text()).toBe(201);
    const createdBody = await created.json() as { policyVersionId: string };
    const updated = await request(`/hr/bonus/policies/${createdBody.policyVersionId}`, "PATCH", { name: "已調整 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "individual_performance", performancePeriod: "previous_month", ratePpm: 30_000, guaranteeMinor: 500_000, validFrom: "2026-02-01" });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const updatedBody = await updated.json() as { versionNumber: number; policyVersionId: string };
    expect(updatedBody.versionNumber).toBe(2);
    const assignments = await (await request("/hr/bonus/assignments")).json() as { assignments: Array<{ policyVersionId: string; employeeUserId: string; assignment: { validFrom: string; validTo: string | null } }> };
    expect(assignments.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyVersionId: createdBody.policyVersionId, employeeUserId: "dev-wang@ecotech.tw", assignment: expect.objectContaining({ validFrom: "2026-01-01", validTo: "2026-02-01" }) }),
      expect.objectContaining({ policyVersionId: updatedBody.policyVersionId, employeeUserId: "dev-wang@ecotech.tw", assignment: expect.objectContaining({ validFrom: "2026-02-01", validTo: null }) }),
    ]));
    const policies = await (await request("/hr/bonus/policies")).json() as { policies: Array<{ policyVersionId: string; policyName: string; versionNumber: number; bonusKind: string; performancePeriod: string; ratePpm: number; guaranteeMinor: number }> };
    expect(policies.policies).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyVersionId: createdBody.policyVersionId, versionNumber: 1 }),
      expect.objectContaining({ policyVersionId: updatedBody.policyVersionId, policyName: "已調整 policy", versionNumber: 2, bonusKind: "individual_performance", performancePeriod: "previous_month", ratePpm: 30_000, guaranteeMinor: 500_000 }),
    ]));
    const filtered = await (await request("/hr/bonus/policies?page=1&pageSize=10&search=%E5%B7%B2%E8%AA%BF%E6%95%B4&bonusKind=individual_performance")).json() as { policies: Array<{ policyVersionId: string }>; total: number; page: number; pageSize: number };
    expect(filtered).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(filtered.policies).toEqual([expect.objectContaining({ policyVersionId: updatedBody.policyVersionId })]);
    const deleted = await request(`/hr/bonus/policies/${updatedBody.policyVersionId}`, "DELETE");
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const deletedBody = await deleted.json() as { deleted: boolean };
    expect(deletedBody.deleted).toBe(true);
    expect((await request(`/hr/bonus/policies/${updatedBody.policyVersionId}/members`, "POST", { employeeUserId: "dev-wang@ecotech.tw", validFrom: "2026-03-01" })).status).toBe(409);
    expect((await request("/hr/bonus/pools/calculate", "POST", { policyVersionId: updatedBody.policyVersionId, periodKey: "2026-08", revenue: [] })).status).toBe(409);
    const activePolicies = await (await request("/hr/bonus/policies")).json() as { policies: Array<{ policyVersionId: string }> };
    expect(activePolicies.policies.some((policy) => policy.policyVersionId === createdBody.policyVersionId || policy.policyVersionId === updatedBody.policyVersionId)).toBe(false);
  });

  it("一般員工不能讀取薪資與獎金資料", async () => {
    cookie = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id: "dev-chen@ecotech.tw", email: "chen@ecotech.tw", name: "陳美玲", pictureUrl: "" }), SECRET))}`;
    expect((await request("/hr/bonus/policies")).status).toBe(403);
    expect((await request("/hr/payroll/runs/not-for-staff")).status).toBe(403);
  });

  it("只用已發布班表日期的核准業績，按保底後固定比例計算櫃點獎金", async () => {
    const policies = await (await request("/hr/bonus/policies")).json() as { policies: Array<{ policyVersionId: string; bonusKind: string; performancePeriod: string }> };
    expect(policies.policies[0]).toMatchObject({ bonusKind: "team_performance", performancePeriod: "current_month" });
    const assignments = await (await request("/hr/bonus/assignments")).json() as { assignments: Array<{ employeeName: string; policyName: string; assignment: { employmentId: string } }> };
    expect(assignments.assignments[0]).toMatchObject({ employeeName: "王小明", policyName: "西門櫃點保底 5% 獎金", assignment: { employmentId: "dev-employment-wang" } });
    const response = await request("/hr/bonus/pools/calculate", "POST", {
      policyVersionId: policies.policies[0]!.policyVersionId,
      periodKey: "2026-08",
      revenue: [
        { businessDate: "2026-08-01", amountMinor: 18_000_000, sourceKind: "manual", sourceRef: "approved-001" },
        { businessDate: "2026-08-02", amountMinor: 18_000_000, sourceKind: "manual", sourceRef: "not-scheduled" },
      ],
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const body = await response.json() as { pool: { poolAmountMinor: number; warnings: string[]; allocations: Array<{ employeeName: string; scheduledDays: number; amountMinor: number }>; daily: Array<{ businessDate: string; bonusMinor: number; scheduled: boolean }> } };
    expect(body.pool.poolAmountMinor).toBe(150_000);
    expect(body.pool.warnings).toContain("業績是此次請求明確帶入的快照；未自動套用出金表。");
    expect(body.pool.allocations).toEqual([expect.objectContaining({ employeeName: "王小明", scheduledDays: 14, amountMinor: 150_000 })]);
    expect(body.pool.daily).toEqual(expect.arrayContaining([
      expect.objectContaining({ businessDate: "2026-08-01", bonusMinor: 150_000, scheduled: true }),
      expect.objectContaining({ businessDate: "2026-08-02", bonusMinor: 0, scheduled: false }),
    ]));
    const pools = await listHrBonusPools(createDatabase(d1 as never), "2026-08");
    expect(pools).toHaveLength(2);
  });
});
