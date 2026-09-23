import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { eq } from "drizzle-orm";
import { createDatabase } from "@rueisiang/db";
import { hrLeaveRequests, hrLeaveTypes, hrMonthlyLeaveEntries, hrOvertimeRequests, hrSpecialWorkdayAssignments, hrSpecialWorkdayRuleVersions, hrSpecialWorkdayRules, reportPayoutDaily } from "@rueisiang/db/schema";
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
  it("提供 HRIS 概覽的四個待辦摘要", async () => {
    const response = await request("/hr/overview");
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { periodKey: string; attendance: { anomalyCount: number }; schedule: { status: string; missingEmployeeCount: number }; insurance: { totalEmployeeCount: number; missingEmployeeCount: number }; payroll: { status: string; runId: string | null } };
    expect(body.periodKey).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect(body.attendance.anomalyCount).toBeGreaterThanOrEqual(0);
    expect(body.schedule.missingEmployeeCount).toBeGreaterThanOrEqual(0);
    expect(body.insurance.totalEmployeeCount).toBeGreaterThanOrEqual(0);
    expect(body.payroll).toEqual(expect.objectContaining({ status: expect.any(String) }));
  });

  it("使用林瑞翔的假勤與加班紀錄建立辦公室薪資單", async () => {
    const invalidScope = await request("/hr/bonus/policies", "POST", { name: "不存在通路", scopeId: "missing-scope", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 50_000, guaranteeMinor: 0 });
    expect(invalidScope.status, await invalidScope.clone().text()).toBe(404);
    // 信義店整個月都沒有出金：團體績效不看排班，缺的是業績，所以要提醒缺出金，不是安靜給 0。
    await createDatabase(d1 as never).delete(reportPayoutDaily);
    const policyResponse = await request("/hr/bonus/policies", "POST", { name: "林瑞翔無業績測試", scopeId: "cyberbiz:store:demo-xinyi", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 50_000, guaranteeMinor: 0, employeeUserIds: ["dev-eli-lin@ecotech.tw"], assignmentValidFrom: "2026-01-01" });
    expect(policyResponse.status, await policyResponse.clone().text()).toBe(201);
    const response = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08",
      attendanceMode: "general",
      employeeUserIds: ["dev-eli-lin@ecotech.tw"],
      requestId: "test-payroll-2026-08-lin",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { run: { runId: string; status: string; warnings: string[]; employees: Array<{ employeeName: string; earningMinor: number; deductionMinor: number; netMinor: number; lines: Array<{ lineKey: string; amountMinor: number; explanation: Record<string, unknown> }> }> } };
    expect(body.run.status).toBe("ready");
    expect(body.run.warnings).not.toContain("本版未計算勞健保扣款：員工尚未建立有效的加保版本。");
    expect(body.run.warnings.some((warning) => warning.includes("林瑞翔") && warning.includes("31 天缺少當月出金資料"))).toBe(true);
    expect(body.run.warnings.some((warning) => warning.includes("沒有涵蓋通路的已發布排班"))).toBe(false);
    expect(body.run.employees[0]).toMatchObject({ employeeUserId: "dev-eli-lin@ecotech.tw", employeeName: "林瑞翔", earningMinor: 6_116_665, deductionMinor: 385_500, netMinor: 5_731_165 });
    expect(body.run.employees[0]!.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineKey: "base_salary", amountMinor: 6_000_000, explanation: expect.objectContaining({ formulaDetail: "月薪 NT$ 60,000 × 1 個月 = NT$ 60,000" }) }),
      expect.objectContaining({ lineKey: "overtime", amountMinor: 116_665 }),
      expect.objectContaining({ lineKey: "unpaid_leave", amountMinor: 200_000 }),
      expect.objectContaining({ lineKey: "labor_insurance", amountMinor: 114_500 }),
      expect.objectContaining({ lineKey: "health_insurance", amountMinor: 71_000 }),
    ]));
    const labor = body.run.employees[0]!.lines.find((line) => line.lineKey === "labor_insurance");
    expect(labor).toMatchObject({ explanation: expect.objectContaining({ formulaDetail: expect.stringContaining("11.5%") }) });
    expect(labor?.explanation.formulaDetail).toEqual(expect.stringContaining("1%"));
    expect(labor?.explanation.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: "ordinary_accident", employeeAmountMinor: 105_300 }),
      expect.objectContaining({ component: "employment", employeeAmountMinor: 9_200 }),
    ]));
    const repeat = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-08", attendanceMode: "general", employeeUserIds: ["dev-eli-lin@ecotech.tw"], requestId: "test-payroll-2026-08-lin" });
    expect((await repeat.json() as { run: { runId: string } }).run.runId).toBe(body.run.runId);
  });

  it("31 日月份整月月薪與月給項目不按 31／30 放大", async () => {
    const compensation = await request("/hr/employments/dev-employment-sixmonth/compensation", "POST", {
      validFrom: "2026-03-02", payBasis: "monthly", baseAmountMinor: 3_600_000, note: "31 日月份整月月薪測試", items: [
        { itemName: "職務加給", amountMinor: 200_000, itemKind: "fixed", amountBasis: "monthly", includeOvertime: false, includeInsurance: false, includeTax: false },
        { itemName: "全勤獎金", amountMinor: 200_000, itemKind: "fixed", amountBasis: "monthly", includeOvertime: false, includeInsurance: false, includeTax: false },
      ],
    });
    expect(compensation.status, await compensation.clone().text()).toBe(201);
    const response = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08", employeeUserIds: ["dev-sixmonth@ecotech.tw"], requestId: "test-payroll-full-month-31-days",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { run: { employees: Array<{ earningMinor: number; lines: Array<{ lineKey: string; amountMinor: number; explanation: Record<string, unknown> }> }> } };
    const employee = body.run.employees[0]!;
    expect(employee.earningMinor).toBe(4_000_000);
    expect(employee.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineKey: "base_salary", amountMinor: 3_600_000, explanation: expect.objectContaining({ formulaDetail: "月薪 NT$ 36,000 × 1 個月 = NT$ 36,000" }) }),
      expect.objectContaining({ lineKey: "salary_item_1", amountMinor: 200_000, explanation: expect.objectContaining({ formulaDetail: "月給 NT$ 2,000 × 1 個月 = NT$ 2,000" }) }),
      expect.objectContaining({ lineKey: "salary_item_2", amountMinor: 200_000, explanation: expect.objectContaining({ formulaDetail: "月給 NT$ 2,000 × 1 個月 = NT$ 2,000" }) }),
    ]));
  });

  it("只按報到後的在職日驗證與計算員工薪資", async () => {
    d1.sqlite.exec(`
      UPDATE hr_employment_service_periods SET service_start_on='2026-08-03' WHERE employment_id='dev-employment-newhire';
      UPDATE hr_compensation_versions SET valid_from='2026-08-03' WHERE id='dev-comp-newhire-2026';
    `);
    const response = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08", employeeUserIds: ["dev-newhire@ecotech.tw"], requestId: "test-payroll-newhire-2026-08",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { run: { employees: Array<{ employeeUserId: string; lines: Array<{ lineKey: string; amountMinor: number; explanation: Record<string, unknown> }> }> } };
    const employee = body.run.employees[0]!;
    const baseSalary = employee.lines.find((line) => line.lineKey === "base_salary");
    expect(employee.employeeUserId).toBe("dev-newhire@ecotech.tw");
    expect(baseSalary?.amountMinor).toBeGreaterThan(0);
    expect(baseSalary?.explanation.formulaDetail).toEqual(expect.stringContaining("29 天"));

    const noEmploymentPeriod = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-07", employeeUserIds: ["dev-newhire@ecotech.tw"], requestId: "test-payroll-newhire-2026-07",
    });
    expect(noEmploymentPeriod.status, await noEmploymentPeriod.clone().text()).toBe(400);
    expect((await noEmploymentPeriod.json() as { error: string }).error).toContain("沒有在職區間");
  });

  it("不把到職日前的加班、請假與特殊日補貼帶進薪資", async () => {
    const db = createDatabase(d1 as never);
    const employmentId = "dev-employment-newhire";
    const actor = "dev-eli-lin@ecotech.tw";
    const [unpaidLeave] = await db.select({ id: hrLeaveTypes.id }).from(hrLeaveTypes).where(eq(hrLeaveTypes.name, "無薪假")).limit(1);
    expect(unpaidLeave).toBeDefined();
    await db.insert(hrOvertimeRequests).values({
      id: "test-newhire-prestart-overtime", employmentId, scopeId: null,
      requestedStart: "2026-08-01 10:00:00", requestedEnd: "2026-08-01 12:00:00",
      actualStart: "2026-08-01 10:00:00", actualEnd: "2026-08-01 12:00:00",
      settlementKind: "pay", status: "approved", ratePpm: 1_333_333, reason: "到職前加班測試",
      reviewedBy: actor, reviewedAt: "2026-08-02 09:00:00", createdBy: actor,
    });
    await db.insert(hrLeaveRequests).values({
      id: "test-newhire-prestart-leave", employmentId, leaveTypeId: unpaidLeave!.id, leaveType: "無薪假",
      status: "approved", startsAt: "2026-08-01 01:00:00", endsAt: "2026-08-02 01:00:00", startsOn: "2026-08-01", endsOn: "2026-08-02",
      durationMinutes: 480, payRatePpm: 0, reason: "到職前請假測試", reviewedBy: actor, reviewedAt: "2026-08-02 09:00:00", createdBy: actor,
    });
    await db.insert(hrMonthlyLeaveEntries).values({
      id: "test-newhire-prestart-monthly-leave", employmentId, leaveTypeId: unpaidLeave!.id, leaveDate: "2026-08-01",
      hoursHalfUnits: 16, payRatePpm: 0, deductionAmount: 10_000, note: "到職前月度扣款測試", createdBy: actor, updatedBy: actor,
    });
    await db.insert(hrSpecialWorkdayRules).values({ id: "test-newhire-prestart-special-rule", name: "到職前特殊日測試", active: 1, createdBy: actor });
    await db.insert(hrSpecialWorkdayRuleVersions).values({
      id: "test-newhire-prestart-special-version", ruleId: "test-newhire-prestart-special-rule", versionNumber: 1,
      validFrom: "2026-01-01", validTo: null, wageKind: "fixed_hourly", fixedAmountMinor: 10_000, multiplierPpm: null,
      overtimeRule: "測試級距", workSource: "hourly", note: "", createdBy: actor,
    });
    await db.insert(hrSpecialWorkdayAssignments).values({
      id: "test-newhire-prestart-special-assignment", ruleVersionId: "test-newhire-prestart-special-version", employmentId, workerId: null,
      workDate: "2026-08-01", ruleNameSnapshot: "到職前特殊日測試", wageKindSnapshot: "fixed_hourly", fixedAmountMinorSnapshot: 10_000,
      multiplierPpmSnapshot: null, workSourceSnapshot: "hourly", allowanceSnapshotJson: JSON.stringify([{ itemName: "特殊日補貼", unitAmountMinor: 5_000 }]),
      allowanceQuantity: 1, appliedBy: actor,
    });
    d1.sqlite.exec("UPDATE hr_employment_service_periods SET service_start_on='2026-08-03' WHERE employment_id='dev-employment-newhire'");
    const response = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-08", employeeUserIds: ["dev-newhire@ecotech.tw"], requestId: "test-newhire-prestart-inputs" });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { run: { employees: Array<{ lines: Array<{ lineKey: string }> }> } };
    const lineKeys = body.run.employees[0]!.lines.map((line) => line.lineKey);
    expect(lineKeys).not.toContain("overtime");
    expect(lineKeys).not.toContain("unpaid_leave");
    expect(lineKeys).not.toContain("special_workday");
    expect(lineKeys).not.toContain("special_allowance_1");
  });

  it("保存健保眷屬倍數與每筆薪資公式", async () => {
    d1.sqlite.exec("UPDATE hr_insurance_versions SET dependent_count = 2 WHERE id = 'dev-insurance-lin-health-2026'");
    const response = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-08", attendanceMode: "general", employeeUserIds: ["dev-eli-lin@ecotech.tw"], requestId: "test-payroll-formula-snapshot" });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { run: { employees: Array<{ lines: Array<{ lineKey: string; explanation: Record<string, unknown>; amountMinor: number }> }> } };
    const lines = body.run.employees[0]!.lines;
    const health = lines.find((line) => line.lineKey === "health_insurance");
    expect(health).toMatchObject({ amountMinor: 213_000, explanation: expect.objectContaining({ dependentCount: 2, formulaDetail: expect.stringContaining("2 位親屬 × 100%") }) });
    const base = lines.find((line) => line.lineKey === "base_salary");
    expect(base?.explanation.formulaDetail).toEqual(expect.stringContaining("月薪"));
    const overtime = lines.find((line) => line.lineKey === "overtime");
    expect(overtime?.explanation.formulaDetail).toEqual(expect.stringContaining("小時"));
  });

  it("薪資批次列表分開保留批次狀態與薪資期間狀態", async () => {
    const calculated = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-08", attendanceMode: "general", employeeUserIds: ["dev-eli-lin@ecotech.tw"], requestId: "test-payroll-run-list-status" });
    expect(calculated.status, await calculated.clone().text()).toBe(200);
    const listed = await request("/hr/payroll/runs");
    expect(listed.status, await listed.clone().text()).toBe(200);
    const body = await listed.json() as { runs: Array<{ run: { requestId: string; status: string }; periodStatus: string }> };
    expect(body.runs.find((item) => item.run.requestId === "test-payroll-run-list-status")).toMatchObject({ run: { status: "ready" }, periodStatus: "open" });
  });

  it("保存結算名稱、為指定員工產生預設名稱並限制名稱長度", async () => {
    const selected = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08", employeeUserIds: ["dev-eli-lin@ecotech.tw"], requestId: "test-payroll-run-name-default",
    });
    expect(selected.status, await selected.clone().text()).toBe(200);
    const selectedBody = await selected.json() as { run: { runId: string; runName: string } };
    expect(selectedBody.run.runName).toBe("林瑞翔");

    const custom = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08", employeeUserIds: ["dev-eli-lin@ecotech.tw"], runName: "八月林瑞翔薪資", requestId: "test-payroll-run-name-custom",
    });
    expect(custom.status, await custom.clone().text()).toBe(200);
    const customBody = await custom.json() as { run: { runId: string; runName: string } };
    expect(customBody.run.runName).toBe("八月林瑞翔薪資");
    expect((await (await request(`/hr/payroll/runs/${customBody.run.runId}`)).json() as { run: { runName: string } }).run.runName).toBe("八月林瑞翔薪資");

    const listed = await request("/hr/payroll/runs");
    const listedBody = await listed.json() as { runs: Array<{ run: { requestId: string; runName: string } }> };
    expect(listedBody.runs.find((item) => item.run.requestId === "test-payroll-run-name-custom")?.run.runName).toBe("八月林瑞翔薪資");

    const tooLong = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08", employeeUserIds: ["dev-eli-lin@ecotech.tw"], runName: "字".repeat(21), requestId: "test-payroll-run-name-too-long",
    });
    expect(tooLong.status, await tooLong.clone().text()).toBe(400);
  });

  it("按員工套用的 policy 自動計算櫃位業績獎金並四捨五入到元", async () => {
    const db = createDatabase(d1 as never);
    await db.delete(reportPayoutDaily);
    // 8/2 王小明沒有排班：團體績效照樣算進去。
    await db.insert(reportPayoutDaily).values([
      { scopeId: "cyberbiz:store:demo-ximen", businessDate: "2026-08-01", recordOrigin: "manual" as const, reportRunId: null, payoutAmount: 250_000, updatedByEmail: "eli-lin@ecotech.tw" },
      { scopeId: "cyberbiz:store:demo-ximen", businessDate: "2026-08-02", recordOrigin: "manual" as const, reportRunId: null, payoutAmount: 138_500, updatedByEmail: "eli-lin@ecotech.tw" },
    ]);
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
      // 西門整月出金 NT$388,500（= 38,850,000 分）；扣保底 15,000,000 分後乘 5%，就是這個數字。只有一位成員，池全歸他。
      expect.objectContaining({ lineKey: "bonus_1", amountMinor: 1_192_500, explanation: expect.objectContaining({
        bonusKind: "team_performance", performancePeriod: "current_month", rounding: "nearest_ntd_dollar",
        revenueMinor: 38_850_000, poolAmountMinor: 1_192_500, scheduledDays: null, weightUnits: 1, weightedTotal: 1,
        formulaDetail: expect.stringContaining("max(0, NT$ 388,500 − NT$ 150,000) × 5%"),
      }) }),
    ]));
  });

  it("團體績效只按權重分，不看排班天數", async () => {
    const db = createDatabase(d1 as never);
    await db.delete(reportPayoutDaily);
    // 前月業績 NT$747,665、1.5%、保底 NT$300,000，權重 2／1／1。陳與林在 7 月一天班都沒排，陳也不在這次結算批次裡。
    await db.insert(reportPayoutDaily).values([{ scopeId: "cyberbiz:store:demo-ximen", businessDate: "2026-07-15", recordOrigin: "manual" as const, reportRunId: null, payoutAmount: 747_665, updatedByEmail: "eli-lin@ecotech.tw" }]);
    const created = await request("/hr/bonus/policies", "POST", {
      name: "權重分配", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "previous_month", ratePpm: 15_000, guaranteeMinor: 30_000_000, assignmentValidFrom: "2026-01-01",
      employeeAssignments: [{ employeeUserId: "dev-wang@ecotech.tw", weightUnits: 2 }, { employeeUserId: "dev-chen@ecotech.tw", weightUnits: 1 }, { employeeUserId: "dev-eli-lin@ecotech.tw", weightUnits: 1 }],
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const payroll = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-08", employeeUserIds: ["dev-wang@ecotech.tw", "dev-eli-lin@ecotech.tw"], requestId: "test-payroll-team-weight-only" });
    expect(payroll.status, await payroll.clone().text()).toBe(200);
    const body = await payroll.json() as { run: { employees: Array<{ employeeUserId: string; lines: Array<{ amountMinor: number; explanation: Record<string, unknown> }> }>; warnings: string[] } };
    const share = (userId: string) => body.run.employees.find((employee) => employee.employeeUserId === userId)?.lines.find((line) => line.explanation.policyName === "權重分配");
    // (747,665 − 300,000) × 1.5% ÷ 4 × 2 = 3,357.4875，每個人最後才四捨五入到元 → 3,357。
    // 先把池捨入成 6,715 再分會變成 3,357.50，那是舊的錯誤算法。
    expect(share("dev-wang@ecotech.tw")).toMatchObject({ amountMinor: 335_700, explanation: expect.objectContaining({ poolAmountMinor: 671_500, weightUnits: 2, weightedTotal: 4, scheduledDays: null }) });
    // 林瑞翔是一般制，7 月一天班都沒排，照樣按權重 1 分到四分之一；陳不在這批也要算進分母。
    // 1,678.74375 → 1,679。
    expect(share("dev-eli-lin@ecotech.tw")).toMatchObject({ amountMinor: 167_900 });
    expect(body.run.warnings.some((warning) => warning.includes("權重分配") && warning.includes("沒有涵蓋通路的已發布排班"))).toBe(false);
  });

  it("多 Scope 的團體獎金先合併兩店出金再只扣一次保底", async () => {
    const created = await request("/hr/bonus/policies", "POST", {
      name: "跨店團體績效", scopeIds: ["cyberbiz:store:demo-ximen", "cyberbiz:store:demo-xinyi"], bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 50_000, guaranteeMinor: 15_000_000, employeeUserIds: ["dev-wang@ecotech.tw"], assignmentValidFrom: "2026-01-01",
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const db = createDatabase(d1 as never);
    await db.delete(reportPayoutDaily);
    // 王小明從沒在信義排班，信義的出金照樣算進團體業績。
    await db.insert(reportPayoutDaily).values([
      { scopeId: "cyberbiz:store:demo-ximen", businessDate: "2026-08-01", recordOrigin: "manual" as const, reportRunId: null, payoutAmount: 3_885_000, updatedByEmail: "eli-lin@ecotech.tw" },
      { scopeId: "cyberbiz:store:demo-xinyi", businessDate: "2026-08-02", recordOrigin: "manual" as const, reportRunId: null, payoutAmount: 100_000, updatedByEmail: "eli-lin@ecotech.tw" },
    ]);
    const payroll = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-08", attendanceMode: "scheduled", employeeUserIds: ["dev-wang@ecotech.tw"], requestId: "test-payroll-2026-08-wang-multiscope" });
    expect(payroll.status, await payroll.clone().text()).toBe(200);
    const body = await payroll.json() as { run: { employees: Array<{ lines: Array<{ amountMinor: number; explanation: Record<string, unknown> }> }> } };
    const crossStore = body.run.employees[0]!.lines.find((line) => line.explanation.policyName === "跨店團體績效");
    /*
     * 西門 388,500,000 加信義 10,000,000 是 398,500,000，保底只扣一次。兩店各自扣一次的話
     * 會少扣 15,000,000 ——多 Scope 的政策最容易錯在這裡，所以要有一條測試盯著。
     */
    expect(crossStore?.explanation).toMatchObject({ revenueMinor: 398_500_000, scheduledDays: null });
    expect(crossStore?.amountMinor).toBe(19_175_000);
  });

  it("同一員工可套用多筆 policy，計薪時合併自動獎金", async () => {
    const db = createDatabase(d1 as never);
    await db.delete(reportPayoutDaily);
    // 8/1 有排班、8/2 沒有：團體算兩天，個人只算自己排到的 8/1。
    await db.insert(reportPayoutDaily).values([
      { scopeId: "cyberbiz:store:demo-ximen", businessDate: "2026-08-01", recordOrigin: "manual" as const, reportRunId: null, payoutAmount: 300_000, updatedByEmail: "eli-lin@ecotech.tw" },
      { scopeId: "cyberbiz:store:demo-ximen", businessDate: "2026-08-02", recordOrigin: "manual" as const, reportRunId: null, payoutAmount: 100_000, updatedByEmail: "eli-lin@ecotech.tw" },
    ]);
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
    const payroll = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-08", attendanceMode: "scheduled", employeeUserIds: ["dev-wang@ecotech.tw"], requestId: "test-payroll-2026-08-wang-multiple" });
    expect(payroll.status, await payroll.clone().text()).toBe(200);
    const body = await payroll.json() as { run: { employees: Array<{ lines: Array<{ amountMinor: number; explanation: Record<string, unknown> }> }> } };
    const lines = body.run.employees[0]!.lines;
    expect(lines).toEqual(expect.arrayContaining([
      // 兩個政策的業績都來自同一份出金表。團體 3.3333% × 整月 400,000 元；個人 1% × 自己排班日（14 天，只有 8/1 有出金）的 300,000 元。
      expect.objectContaining({ amountMinor: 1_333_300, explanation: expect.objectContaining({ policyName: "測試團體績效", revenueMinor: 40_000_000 }) }),
      expect.objectContaining({ amountMinor: 300_000, explanation: expect.objectContaining({ bonusKind: "individual_performance", revenueMinor: 30_000_000, scheduledDays: 14 }) }),
    ]));
  });

  it("並行套用同一 policy 的同一員工只成功一次，並行版本更新不覆寫彼此", async () => {
    const created = await request("/hr/bonus/policies", "POST", { name: "競態 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 20_000, guaranteeMinor: 0 });
    expect(created.status, await created.clone().text()).toBe(201);
    const policyVersionId = (await created.json() as { policyVersionId: string }).policyVersionId;
    const memberResponses = await Promise.all([
      request(`/hr/bonus/policies/${policyVersionId}/members`, "POST", { employeeUserId: "dev-wang@ecotech.tw", validFrom: "2026-01-01" }),
      request(`/hr/bonus/policies/${policyVersionId}/members`, "POST", { employeeUserId: "dev-wang@ecotech.tw", validFrom: "2026-01-01" }),
    ]);
    expect(memberResponses.map((response) => response.status).sort()).toEqual([201, 409]);
    const versionResponses = await Promise.all([
      request(`/hr/bonus/policies/${policyVersionId}`, "PATCH", { name: "競態 policy A", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "individual_performance", performancePeriod: "current_month", ratePpm: 30_000, guaranteeMinor: 0, validFrom: "2026-02-01" }),
      request(`/hr/bonus/policies/${policyVersionId}`, "PATCH", { name: "競態 policy B", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "individual_performance", performancePeriod: "current_month", ratePpm: 40_000, guaranteeMinor: 0, validFrom: "2026-02-01" }),
    ]);
    expect(versionResponses.filter((response) => response.status === 200)).toHaveLength(1);
    expect([400, 409]).toContain(versionResponses.find((response) => response.status !== 200)?.status);
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
    expect((await request(`/hr/bonus/policies/${createdBody.policyVersionId}`, "PATCH", { name: "過期版本不可編輯", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 20_000, guaranteeMinor: 0, validFrom: "2026-03-01" })).status).toBe(409);
    expect((await request(`/hr/bonus/policies/${createdBody.policyVersionId}/members`, "POST", { employeeUserId: "dev-wang@ecotech.tw", validFrom: "2026-03-01" })).status).toBe(400);
    const policies = await (await request("/hr/bonus/policies")).json() as { policies: Array<{ policyVersionId: string; policyName: string; versionNumber: number; bonusKind: string; performancePeriod: string; ratePpm: number; guaranteeMinor: number }> };
    expect(policies.policies).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyVersionId: updatedBody.policyVersionId, policyName: "已調整 policy", versionNumber: 2, bonusKind: "individual_performance", performancePeriod: "previous_month", ratePpm: 30_000, guaranteeMinor: 500_000 }),
    ]));
    expect(policies.policies.some((policy) => policy.policyVersionId === createdBody.policyVersionId)).toBe(false);
    const filtered = await (await request("/hr/bonus/policies?page=1&pageSize=10&search=%E5%B7%B2%E8%AA%BF%E6%95%B4&bonusKind=individual_performance")).json() as { policies: Array<{ policyVersionId: string }>; total: number; page: number; pageSize: number };
    expect(filtered).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(filtered.policies).toEqual([expect.objectContaining({ policyVersionId: updatedBody.policyVersionId })]);
    const deleted = await request(`/hr/bonus/policies/${updatedBody.policyVersionId}`, "DELETE");
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const deletedBody = await deleted.json() as { deleted: boolean };
    expect(deletedBody.deleted).toBe(true);
    expect((await request(`/hr/bonus/policies/${updatedBody.policyVersionId}/members`, "POST", { employeeUserId: "dev-wang@ecotech.tw", validFrom: "2026-03-01" })).status).toBe(409);
    const activePolicies = await (await request("/hr/bonus/policies")).json() as { policies: Array<{ policyVersionId: string }> };
    expect(activePolicies.policies.some((policy) => policy.policyVersionId === createdBody.policyVersionId || policy.policyVersionId === updatedBody.policyVersionId)).toBe(false);
  });

  it("解除最新 policy 版本會回到上一版，成員期間一併還原", async () => {
    const created = await request("/hr/bonus/policies", "POST", { name: "可解除 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 20_000, guaranteeMinor: 0, employeeUserIds: ["dev-wang@ecotech.tw"], assignmentValidFrom: "2026-01-01" });
    expect(created.status, await created.clone().text()).toBe(201);
    const first = await created.json() as { policyVersionId: string };
    const updated = await request(`/hr/bonus/policies/${first.policyVersionId}`, "PATCH", { name: "設錯的 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 90_000, guaranteeMinor: 0, validFrom: "2026-02-01" });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const second = await updated.json() as { policyVersionId: string };

    const voided = await request(`/hr/bonus/policies/${second.policyVersionId}/void`, "POST", {});
    expect(voided.status, await voided.clone().text()).toBe(200);
    expect(await voided.json()).toMatchObject({ policyVersionId: second.policyVersionId, previousPolicyVersionId: first.policyVersionId, status: "voided" });

    const policies = await (await request("/hr/bonus/policies")).json() as { policies: Array<{ policyVersionId: string; versionNumber: number; ratePpm: number }> };
    expect(policies.policies).toEqual(expect.arrayContaining([expect.objectContaining({ policyVersionId: first.policyVersionId, versionNumber: 1, ratePpm: 20_000 })]));
    expect(policies.policies.some((policy) => policy.policyVersionId === second.policyVersionId)).toBe(false);

    // 上一版的成員在更新時被關到 2026-02-01；解除後要回到「還在套用」，而不是停在那天。
    const assignments = await (await request("/hr/bonus/assignments")).json() as { assignments: Array<{ policyVersionId: string; assignment: { validFrom: string; validTo: string | null } }> };
    expect(assignments.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyVersionId: first.policyVersionId, assignment: expect.objectContaining({ validFrom: "2026-01-01", validTo: null }) }),
    ]));
    expect(assignments.assignments.some((item) => item.policyVersionId === second.policyVersionId)).toBe(false);

    // 只剩第一版時沒有可以回去的上一版；重複解除也要擋下來。
    expect((await request(`/hr/bonus/policies/${first.policyVersionId}/void`, "POST", {})).status).toBe(409);
    expect((await request(`/hr/bonus/policies/${second.policyVersionId}/void`, "POST", {})).status).toBe(409);

    // 編號取所有版本的最大值：已解除的第 2 版還佔著編號，重建時不能撞回去。
    const rebuilt = await request(`/hr/bonus/policies/${first.policyVersionId}`, "PATCH", { name: "改對的 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 30_000, guaranteeMinor: 0, validFrom: "2026-02-01" });
    expect(rebuilt.status, await rebuilt.clone().text()).toBe(200);
    expect(await rebuilt.json()).toMatchObject({ versionNumber: 3 });
  });

  it("解除會還原成員原本的結束日，被移除的成員也回得來", async () => {
    const created = await request("/hr/bonus/policies", "POST", { name: "成員期間 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 20_000, guaranteeMinor: 0 });
    expect(created.status, await created.clone().text()).toBe(201);
    const first = await created.json() as { policyVersionId: string };
    // 這位成員本來就只套用到 2026-06-30；解除不可以把他變成無限期。
    const member = await request(`/hr/bonus/policies/${first.policyVersionId}/members`, "POST", { employeeUserId: "dev-wang@ecotech.tw", validFrom: "2026-01-01", validTo: "2026-06-30" });
    expect(member.status, await member.clone().text()).toBe(201);

    // 更新時把他從清單拿掉：上一版的成員被關在 2026-02-01，新版本沒有他。
    const updated = await request(`/hr/bonus/policies/${first.policyVersionId}`, "PATCH", { name: "成員期間 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 20_000, guaranteeMinor: 0, validFrom: "2026-02-01", employeeAssignments: [] });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const second = await updated.json() as { policyVersionId: string };
    const closed = await (await request("/hr/bonus/assignments")).json() as { assignments: Array<{ policyVersionId: string; assignment: { validTo: string | null } }> };
    expect(closed.assignments.find((item) => item.policyVersionId === first.policyVersionId)?.assignment.validTo).toBe("2026-02-01");

    expect((await request(`/hr/bonus/policies/${second.policyVersionId}/void`, "POST", {})).status).toBe(200);
    const restored = await (await request("/hr/bonus/assignments")).json() as { assignments: Array<{ policyVersionId: string; assignment: { validFrom: string; validTo: string | null } }> };
    expect(restored.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyVersionId: first.policyVersionId, assignment: expect.objectContaining({ validFrom: "2026-01-01", validTo: "2026-06-30" }) }),
    ]));
  });

  it("解除之後可以把同一位員工重新套用到回復的版本", async () => {
    const created = await request("/hr/bonus/policies", "POST", { name: "重新套用 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 20_000, guaranteeMinor: 0 });
    const first = await created.json() as { policyVersionId: string };
    const updated = await request(`/hr/bonus/policies/${first.policyVersionId}`, "PATCH", { name: "重新套用 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 20_000, guaranteeMinor: 0, validFrom: "2026-02-01", employeeAssignments: [{ employeeUserId: "dev-wang@ecotech.tw", weightUnits: 1 }] });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const second = await updated.json() as { policyVersionId: string };
    expect((await request(`/hr/bonus/policies/${second.policyVersionId}/void`, "POST", {})).status).toBe(200);
    // 已解除版本上那筆成員還留著，但不該擋住重新套用。
    const reassigned = await request(`/hr/bonus/policies/${first.policyVersionId}/members`, "POST", { employeeUserId: "dev-wang@ecotech.tw", validFrom: "2026-02-01" });
    expect(reassigned.status, await reassigned.clone().text()).toBe(201);
  });

  it("解除與同一版本的並行編輯只有一邊成功，不會留下兩個有效版本", async () => {
    const created = await request("/hr/bonus/policies", "POST", { name: "並行解除 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 20_000, guaranteeMinor: 0 });
    const first = await created.json() as { policyVersionId: string };
    const second = await (await request(`/hr/bonus/policies/${first.policyVersionId}`, "PATCH", { name: "並行解除 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 40_000, guaranteeMinor: 0, validFrom: "2026-02-01" })).json() as { policyVersionId: string };
    const [voided, patched] = await Promise.all([
      request(`/hr/bonus/policies/${second.policyVersionId}/void`, "POST", {}),
      request(`/hr/bonus/policies/${second.policyVersionId}`, "PATCH", { name: "並行解除 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 50_000, guaranteeMinor: 0, validFrom: "2026-03-01" }),
    ]);
    expect([voided.status, patched.status].filter((status) => status === 200)).toHaveLength(1);
    // 列表只列每個 policy 目前生效的那一版；有兩個有效版本的話這裡會變成兩列，獎金就會發兩次。
    const policies = await (await request("/hr/bonus/policies?page=1&pageSize=50&search=%E4%B8%A6%E8%A1%8C%E8%A7%A3%E9%99%A4")).json() as { policies: Array<{ policyVersionId: string }> };
    expect(policies.policies).toHaveLength(1);
  });

  it("解除獎金版本之後，已試算的批次要重算才能結帳", async () => {
    const created = await request("/hr/bonus/policies", "POST", { name: "結帳前解除 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 20_000, guaranteeMinor: 0, employeeUserIds: ["dev-wang@ecotech.tw"], assignmentValidFrom: "2026-01-01" });
    expect(created.status, await created.clone().text()).toBe(201);
    const first = await created.json() as { policyVersionId: string };
    const updated = await request(`/hr/bonus/policies/${first.policyVersionId}`, "PATCH", { name: "結帳前解除 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 90_000, guaranteeMinor: 0, validFrom: "2026-02-01" });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const second = await updated.json() as { policyVersionId: string };
    const calculated = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-08", attendanceMode: "scheduled", employeeUserIds: ["dev-wang@ecotech.tw"], requestId: "test-payroll-void-before-close" });
    expect(calculated.status, await calculated.clone().text()).toBe(200);
    const runId = (await calculated.json() as { run: { runId: string } }).run.runId;

    expect((await request(`/hr/bonus/policies/${second.policyVersionId}/void`, "POST", {})).status).toBe(200);
    /*
     * 試算是按解除前的獎金算的，直接結帳等於用已經作廢的規則發錢。解除會動到版本與
     * 成員的來源快照，所以這裡必須被既有的「來源已變更」比對擋下，逼使用者重新試算。
     */
    const close = await request(`/hr/payroll/runs/${runId}/close`, "POST", {});
    expect(close.status, await close.clone().text()).toBe(409);
  });

  it("只有已解除版本涵蓋的通路出金變動，不會擋住結帳", async () => {
    const db = createDatabase(d1 as never);
    const created = await request("/hr/bonus/policies", "POST", { name: "已解除通路 policy", scopeId: "cyberbiz:store:demo-ximen", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 20_000, guaranteeMinor: 0, employeeUserIds: ["dev-wang@ecotech.tw"], assignmentValidFrom: "2026-01-01" });
    expect(created.status, await created.clone().text()).toBe(201);
    const first = await created.json() as { policyVersionId: string };
    // 第二版換到信義店，解除之後信義店就跟這次薪資無關了。
    const updated = await request(`/hr/bonus/policies/${first.policyVersionId}`, "PATCH", { name: "已解除通路 policy", scopeId: "cyberbiz:store:demo-xinyi", bonusKind: "team_performance", performancePeriod: "current_month", ratePpm: 20_000, guaranteeMinor: 0, validFrom: "2026-02-01" });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const second = await updated.json() as { policyVersionId: string };
    expect((await request(`/hr/bonus/policies/${second.policyVersionId}/void`, "POST", {})).status).toBe(200);

    const calculated = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-08", attendanceMode: "scheduled", employeeUserIds: ["dev-wang@ecotech.tw"], requestId: "test-payroll-voided-scope-close" });
    expect(calculated.status, await calculated.clone().text()).toBe(200);
    const runId = (await calculated.json() as { run: { runId: string } }).run.runId;
    await db.insert(reportPayoutDaily).values([
      { scopeId: "cyberbiz:store:demo-xinyi", businessDate: "2026-08-03", recordOrigin: "manual" as const, reportRunId: null, payoutAmount: 999_000, updatedByEmail: "eli-lin@ecotech.tw" },
    ]);
    const close = await request(`/hr/payroll/runs/${runId}/close`, "POST", {});
    expect(close.status, await close.clone().text()).toBe(200);
  });

  it("已發布支援人員排班會在薪資結果中獨立列出，且依有效日薪計算", async () => {
    const worker = await request("/hr/schedule-workers", "POST", { displayName: "測試支援人員" });
    expect(worker.status, await worker.clone().text()).toBe(201);
    const workerId = (await worker.json() as { id: string }).id;
    const compensation = await request(`/hr/schedule-workers/${workerId}/compensation`, "POST", { validFrom: "2026-09-01", validTo: "2026-09-15", payBasis: "daily", baseAmountMinor: 320_000, note: "測試日薪" });
    expect(compensation.status, await compensation.clone().text()).toBe(201);
    const laterCompensation = await request(`/hr/schedule-workers/${workerId}/compensation`, "POST", { validFrom: "2026-09-15", payBasis: "daily", baseAmountMinor: 640_000, note: "測試調薪" });
    expect(laterCompensation.status, await laterCompensation.clone().text()).toBe(201);
    const scheduleResponse = await request("/hr/schedules?periodKey=2026-09&scopeId=cyberbiz:store:demo-ximen");
    expect(scheduleResponse.status, await scheduleResponse.clone().text()).toBe(200);
    const schedule = await scheduleResponse.json() as { shifts: Array<{ versionId: string }>; version: { revision: number } | null };
    expect(schedule.shifts.length).toBeGreaterThan(0);
    const saved = await request("/hr/schedules", "POST", { periodKey: "2026-09", entries: [{ personKind: "worker", workerId, scopeId: "cyberbiz:store:demo-ximen", shiftVersionId: schedule.shifts[0]!.versionId, workDate: "2026-09-03" }] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const savedBody = await saved.json() as { id: string; revision: number };
    const updated = await request("/hr/schedules", "POST", { periodKey: "2026-09", scheduleVersionId: savedBody.id, revision: savedBody.revision, entries: [
      { personKind: "worker", workerId, scopeId: "cyberbiz:store:demo-ximen", shiftVersionId: schedule.shifts[0]!.versionId, workDate: "2026-09-03" },
      { personKind: "worker", workerId, scopeId: "cyberbiz:store:demo-ximen", shiftVersionId: schedule.shifts[0]!.versionId, workDate: "2026-09-16" },
    ] });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const payroll = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-09", employeeUserIds: [], requestId: "test-payroll-worker-2026-09" });
    expect(payroll.status, await payroll.clone().text()).toBe(200);
    const body = await payroll.json() as { run: { workers: Array<{ workerId: string; workerName: string; payBasis: string; scheduledDays: number; amountMinor: number }> } };
    expect(body.run.workers).toEqual(expect.arrayContaining([expect.objectContaining({ workerId, workerName: "測試支援人員", payBasis: "daily", scheduledDays: 2, amountMinor: 960_000 })]));
  });

  it("支援人員可選時薪，並依排班快照的工作時數扣除休息時間計算", async () => {
    const worker = await request("/hr/schedule-workers", "POST", { displayName: "時薪支援人員" });
    expect(worker.status, await worker.clone().text()).toBe(201);
    const workerId = (await worker.json() as { id: string }).id;
    const monthly = await request(`/hr/schedule-workers/${workerId}/compensation`, "POST", { validFrom: "2026-09-01", payBasis: "monthly", baseAmountMinor: 500_000, note: "不應接受月薪" });
    expect(monthly.status, await monthly.clone().text()).toBe(400);
    const daily = await request(`/hr/schedule-workers/${workerId}/compensation`, "POST", { validFrom: "2026-08-01", payBasis: "daily", baseAmountMinor: 320_000, note: "先建立日薪版本" });
    expect(daily.status, await daily.clone().text()).toBe(201);
    const compensation = await request(`/hr/schedule-workers/${workerId}/compensation`, "POST", { validFrom: "2026-09-01", payBasis: "hourly", baseAmountMinor: 50_000, note: "測試時薪" });
    expect(compensation.status, await compensation.clone().text()).toBe(201);
    const shift = await request("/hr/shift-templates", "POST", { scopeId: "cyberbiz:store:demo-ximen", name: "時薪休息班", times: [{ dayType: "weekday", startTime: "09:00", endTime: "18:00", breakMinutes: 60 }] });
    expect(shift.status, await shift.clone().text()).toBe(201);
    const shiftVersionId = (await shift.json() as { versionId: string }).versionId;
    const saved = await request("/hr/schedules", "POST", { periodKey: "2026-09", entries: [
      { personKind: "worker", workerId, scopeId: "cyberbiz:store:demo-ximen", shiftVersionId, workDate: "2026-09-03" },
      { personKind: "worker", workerId, scopeId: "cyberbiz:store:demo-ximen", shiftVersionId, workDate: "2026-09-04" },
    ] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const payroll = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-09", employeeUserIds: [], requestId: "test-payroll-worker-hourly-2026-09" });
    expect(payroll.status, await payroll.clone().text()).toBe(200);
    const body = await payroll.json() as { run: { workers: Array<{ workerId: string; payBasis: string; scheduledDays: number; amountMinor: number }> } };
    // 09:00–18:00 扣 60 分鐘休息＝8 小時；兩天 × NT$500／時。
    expect(body.run.workers).toEqual(expect.arrayContaining([expect.objectContaining({ workerId, payBasis: "hourly", scheduledDays: 2, amountMinor: 800_000 })]));
  });

  it("支援人員時薪套用特殊上班日倍率時仍依排班工時計算", async () => {
    const worker = await request("/hr/schedule-workers", "POST", { displayName: "特殊日時薪支援人員" });
    expect(worker.status, await worker.clone().text()).toBe(201);
    const workerId = (await worker.json() as { id: string }).id;
    const compensation = await request(`/hr/schedule-workers/${workerId}/compensation`, "POST", { validFrom: "2026-09-01", payBasis: "hourly", baseAmountMinor: 50_000, note: "特殊日時薪測試" });
    expect(compensation.status, await compensation.clone().text()).toBe(201);
    const shift = await request("/hr/shift-templates", "POST", { scopeId: "cyberbiz:store:demo-ximen", name: "特殊日時薪班", times: [{ dayType: "weekday", startTime: "09:00", endTime: "18:00", breakMinutes: 60 }] });
    expect(shift.status, await shift.clone().text()).toBe(201);
    const shiftVersionId = (await shift.json() as { versionId: string }).versionId;
    const saved = await request("/hr/schedules", "POST", { periodKey: "2026-09", entries: [{ personKind: "worker", workerId, scopeId: "cyberbiz:store:demo-ximen", shiftVersionId, workDate: "2026-09-03" }] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const rule = await request("/hr/special-workdays/rules", "POST", { name: "特殊日時薪倍率", validFrom: "2026-09-01", wageKind: "multiplier", multiplierPpm: 2_000_000, overtimeRules: [], allowances: [] });
    expect(rule.status, await rule.clone().text()).toBe(201);
    const versionId = (await rule.json() as { versionId: string }).versionId;
    const assigned = await request("/hr/special-workdays/assignments", "POST", { ruleVersionId: versionId, assignments: [{ workerId, workDate: "2026-09-03", allowanceQuantity: 0 }] });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    const payroll = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-09", employeeUserIds: [], requestId: "test-payroll-worker-hourly-special-multiplier-2026-09" });
    expect(payroll.status, await payroll.clone().text()).toBe(200);
    const body = await payroll.json() as { run: { workers: Array<{ workerId: string; payBasis: string; scheduledDays: number; amountMinor: number }> } };
    // 09:00–18:00 扣 60 分鐘休息＝8 小時；NT$500／時 × 2 倍。
    expect(body.run.workers).toEqual(expect.arrayContaining([expect.objectContaining({ workerId, payBasis: "hourly", scheduledDays: 1, amountMinor: 800_000 })]));
  });

  it("封存員工的已發布排班可查且不會在儲存其他排班時被刪除", async () => {
    const scheduleResponse = await request("/hr/schedules?periodKey=2026-09&scopeId=cyberbiz:store:demo-ximen");
    expect(scheduleResponse.status, await scheduleResponse.clone().text()).toBe(200);
    const schedule = await scheduleResponse.json() as { shifts: Array<{ versionId: string }>; version: { id: string; revision: number } | null };
    expect(schedule.shifts.length).toBeGreaterThan(0);
    const saved = await request("/hr/schedules", "POST", { periodKey: "2026-09", entries: [{ personKind: "employee", employmentId: "dev-employment-chen", scopeId: "cyberbiz:store:demo-ximen", shiftVersionId: schedule.shifts[0]!.versionId, workDate: "2026-09-03" }] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const savedBody = await saved.json() as { id: string; revision: number };
    const profile = await (await request("/hr/employees/dev-chen@ecotech.tw")).json() as { employee: { revision: number } };
    const archived = await request("/hr/employments/dev-employment-chen/archive", "POST", { revision: profile.employee.revision });
    expect(archived.status, await archived.clone().text()).toBe(200);
    const history = await (await request("/hr/schedules?periodKey=2026-09&scopeId=cyberbiz:store:demo-ximen")).json() as { entries: Array<{ employmentId: string; archivedAt: string | null }> };
    expect(history.entries).toEqual(expect.arrayContaining([expect.objectContaining({ employmentId: "dev-employment-chen", archivedAt: expect.any(String) })]));
    const updated = await request("/hr/schedules", "POST", { periodKey: "2026-09", scheduleVersionId: savedBody.id, revision: savedBody.revision, entries: [] });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(d1.sqlite.prepare("SELECT count(*) AS count FROM hr_schedule_entries WHERE schedule_version_id=? AND employment_id=?").get(savedBody.id, "dev-employment-chen")).toEqual({ count: 1 });
  });

  it("日薪員工只按已發布排班日期計薪，沒有排班不把整月任職日當成出勤", async () => {
    const compensation = await request("/hr/employments/dev-employment-chen/compensation", "POST", { validFrom: "2026-09-01", payBasis: "daily", baseAmountMinor: 180_000, note: "測試日薪", items: [
      // 月給的職務津貼：日薪員工上幾天班都整月發一次。
      { itemName: "職務津貼", amountMinor: 300_000, itemKind: "fixed", amountBasis: "monthly", includeOvertime: true, includeInsurance: true, includeTax: true },
    ] });
    expect(compensation.status, await compensation.clone().text()).toBe(201);
    const mode = await request("/hr/employments/dev-employment-chen/attendance-mode", "PATCH", { attendanceMode: "scheduled", revision: 1 });
    expect(mode.status, await mode.clone().text()).toBe(200);
    const scheduleResponse = await request("/hr/schedules?periodKey=2026-09&scopeId=cyberbiz:store:demo-ximen");
    expect(scheduleResponse.status, await scheduleResponse.clone().text()).toBe(200);
    const schedule = await scheduleResponse.json() as { version: { id: string; revision: number } | null; shifts: Array<{ versionId: string }> };
    expect(schedule.version).toBeNull();
    expect(schedule.shifts.length).toBeGreaterThan(0);
    const saved = await request("/hr/schedules", "POST", { periodKey: "2026-09", entries: [
      { personKind: "employee", employmentId: "dev-employment-chen", scopeId: "cyberbiz:store:demo-ximen", shiftVersionId: schedule.shifts[0]!.versionId, workDate: "2026-09-03" },
      { personKind: "employee", employmentId: "dev-employment-chen", scopeId: "cyberbiz:store:demo-ximen", shiftVersionId: schedule.shifts[0]!.versionId, workDate: "2026-09-17" },
    ] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const payroll = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-09", attendanceMode: "scheduled", employeeUserIds: ["dev-chen@ecotech.tw"], requestId: "test-payroll-daily-schedule-2026-09" });
    expect(payroll.status, await payroll.clone().text()).toBe(200);
    const body = await payroll.json() as {
      run: {
        employees: Array<{ earningMinor: number; lines: Array<{ lineKey: string; amountMinor: number; explanation: Record<string, unknown> }> }>;
        warnings: string[];
      };
    };
    // 本薪 1,800 × 2 天；職務津貼 3,000／月整月照發一次，不按天數折算，也不是 3,000 × 2。
    expect(body.run.employees[0]).toMatchObject({ earningMinor: 660_000 });
    expect(body.run.employees[0]!.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineKey: "base_salary", amountMinor: 360_000, explanation: expect.objectContaining({ rule: "依已發布排班日期計算；特殊上班日依套用資料" }) }),
      expect.objectContaining({ lineKey: "salary_item_1", amountMinor: 300_000, explanation: expect.objectContaining({ itemName: "職務津貼", amountBasis: "monthly" }) }),
    ]));
    expect(body.run.warnings.some((warning) => warning.includes("日薪制但本期沒有已發布排班"))).toBe(false);
  });

  it("日薪員工月中換敘薪版本時，同名的月給項目只發新版本一次", async () => {
    const itemsWith = (amountMinor: number) => [{ itemName: "職務津貼", amountMinor, itemKind: "fixed", amountBasis: "monthly", includeOvertime: false, includeInsurance: false, includeTax: false }];
    const first = await request("/hr/employments/dev-employment-chen/compensation", "POST", { validFrom: "2026-09-01", payBasis: "daily", baseAmountMinor: 180_000, note: "月初日薪", items: itemsWith(300_000) });
    expect(first.status, await first.clone().text()).toBe(201);
    const second = await request("/hr/employments/dev-employment-chen/compensation", "POST", { validFrom: "2026-09-02", payBasis: "daily", baseAmountMinor: 180_000, note: "月中調整津貼", items: itemsWith(500_000) });
    expect(second.status, await second.clone().text()).toBe(201);
    const mode = await request("/hr/employments/dev-employment-chen/attendance-mode", "PATCH", { attendanceMode: "scheduled", revision: 1 });
    expect(mode.status, await mode.clone().text()).toBe(200);
    const schedule = await (await request("/hr/schedules?periodKey=2026-09&scopeId=cyberbiz:store:demo-ximen")).json() as { shifts: Array<{ versionId: string }> };
    // 兩個版本各排一天，兩個版本的月給項目都會在逐日迴圈裡出現。
    const saved = await request("/hr/schedules", "POST", { periodKey: "2026-09", entries: [
      { personKind: "employee", employmentId: "dev-employment-chen", scopeId: "cyberbiz:store:demo-ximen", shiftVersionId: schedule.shifts[0]!.versionId, workDate: "2026-09-01" },
      { personKind: "employee", employmentId: "dev-employment-chen", scopeId: "cyberbiz:store:demo-ximen", shiftVersionId: schedule.shifts[0]!.versionId, workDate: "2026-09-17" },
    ] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const payroll = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-09", attendanceMode: "scheduled", employeeUserIds: ["dev-chen@ecotech.tw"], requestId: "test-payroll-daily-monthly-item-versions" });
    expect(payroll.status, await payroll.clone().text()).toBe(200);
    const body = await payroll.json() as { run: { employees: Array<{ lines: Array<{ lineKey: string; amountMinor: number; explanation: Record<string, unknown> }> }> } };
    const allowances = body.run.employees[0]!.lines.filter((line) => line.explanation.itemName === "職務津貼");
    expect(allowances).toEqual([expect.objectContaining({ amountMinor: 500_000 })]);
  });

  it("月薪制的每日薪資項目只按工作日計算", async () => {
    const compensation = await request("/hr/employments/dev-employment-chen/compensation", "POST", { validFrom: "2026-09-01", payBasis: "monthly", baseAmountMinor: 180_000, note: "測試月薪", items: [
      { itemName: "每日津貼", amountMinor: 15_000, itemKind: "fixed", amountBasis: "daily", includeOvertime: false, includeInsurance: false, includeTax: false },
    ] });
    expect(compensation.status, await compensation.clone().text()).toBe(201);
    const mode = await request("/hr/employments/dev-employment-chen/attendance-mode", "PATCH", { attendanceMode: "scheduled", revision: 1 });
    expect(mode.status, await mode.clone().text()).toBe(200);
    const scheduleResponse = await request("/hr/schedules?periodKey=2026-09&scopeId=cyberbiz:store:demo-ximen");
    const schedule = await scheduleResponse.json() as { shifts: Array<{ versionId: string }> };
    const saved = await request("/hr/schedules", "POST", { periodKey: "2026-09", entries: [
      { personKind: "employee", employmentId: "dev-employment-chen", scopeId: "cyberbiz:store:demo-ximen", shiftVersionId: schedule.shifts[0]!.versionId, workDate: "2026-09-03" },
      { personKind: "employee", employmentId: "dev-employment-chen", scopeId: "cyberbiz:store:demo-ximen", shiftVersionId: schedule.shifts[0]!.versionId, workDate: "2026-09-17" },
    ] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const payroll = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-09", attendanceMode: "scheduled", employeeUserIds: ["dev-chen@ecotech.tw"], requestId: "test-payroll-daily-item-workdays" });
    expect(payroll.status, await payroll.clone().text()).toBe(200);
    const body = await payroll.json() as { run: { employees: Array<{ earningMinor: number; lines: Array<{ lineKey: string; amountMinor: number }> }> } };
    expect(body.run.employees[0]).toMatchObject({ earningMinor: 210_000 });
    expect(body.run.employees[0]!.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineKey: "base_salary", amountMinor: 180_000 }),
      expect.objectContaining({ lineKey: "salary_item_1", amountMinor: 30_000 }),
    ]));
  });

  it("加班基礎按薪資項目自己的計算單位換算", async () => {
    const compensation = await request("/hr/employments/dev-employment-chen/compensation", "POST", { validFrom: "2026-09-01", payBasis: "daily", baseAmountMinor: 180_000, note: "測試日薪加班", items: [
      { itemName: "月給津貼", amountMinor: 300_000, itemKind: "fixed", amountBasis: "monthly", includeOvertime: true, includeInsurance: false, includeTax: false },
    ] });
    expect(compensation.status, await compensation.clone().text()).toBe(201);
    const adminCookie = cookie;
    cookie = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id: "dev-chen@ecotech.tw", email: "chen@ecotech.tw", name: "陳美玲", pictureUrl: "" }), SECRET))}`;
    const overtime = await request("/hr/me/overtime", "POST", { requestedStart: "2026-09-03 18:00", requestedEnd: "2026-09-03 20:00", settlementKind: "pay", reason: "測試薪資項目加班基礎" });
    expect(overtime.status, await overtime.clone().text()).toBe(201);
    const overtimeId = (await overtime.json() as { id: string }).id;
    cookie = adminCookie;
    const reviewed = await request(`/hr/overtime/${overtimeId}/review`, "POST", { decision: "approved", comment: "核准" });
    expect(reviewed.status, await reviewed.clone().text()).toBe(200);
    const payroll = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-09", attendanceMode: "all", employeeUserIds: ["dev-chen@ecotech.tw"], requestId: "test-payroll-item-overtime-basis" });
    expect(payroll.status, await payroll.clone().text()).toBe(200);
    const body = await payroll.json() as { run: { employees: Array<{ lines: Array<{ lineKey: string; amountMinor: number }> }> } };
    expect(body.run.employees[0]!.lines).toEqual(expect.arrayContaining([
      // (180,000／8 + 300,000／30／8) × 2 小時 × 1.333333。
      expect.objectContaining({ lineKey: "overtime", amountMinor: 63_333 }),
    ]));
  });

  it("特殊上班日加班級距優先套用倍率與固定時薪", async () => {
    const compensation = await request("/hr/employments/dev-employment-chen/compensation", "POST", { validFrom: "2026-09-01", payBasis: "daily", baseAmountMinor: 180_000, note: "特殊日加班級距測試" });
    expect(compensation.status, await compensation.clone().text()).toBe(201);
    const ruleResponse = await request("/hr/special-workdays/rules", "POST", { name: "特殊日加班級距", validFrom: "2026-09-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, overtimeRules: [
      { fromHalfHours: 1, toHalfHours: 4, rateKind: "multiplier", multiplierPpm: 1_500_000 },
      { fromHalfHours: 5, toHalfHours: null, rateKind: "fixed_hourly", fixedAmountMinor: 35000 },
    ], allowances: [] });
    expect(ruleResponse.status, await ruleResponse.clone().text()).toBe(201);
    const versionId = (await ruleResponse.json() as { versionId: string }).versionId;
    const assigned = await request("/hr/special-workdays/assignments", "POST", { ruleVersionId: versionId, assignments: [{ employmentId: "dev-employment-chen", workDate: "2026-09-03", allowanceQuantity: 0 }] });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    const adminCookie = cookie;
    const employeeCookie = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id: "dev-chen@ecotech.tw", email: "chen@ecotech.tw", name: "陳美玲", pictureUrl: "" }), SECRET))}`;
    for (const [requestedStart, requestedEnd] of [["2026-09-03 18:00", "2026-09-03 19:00"], ["2026-09-03 19:00", "2026-09-03 21:00"]]) {
      cookie = employeeCookie;
      const overtime = await request("/hr/me/overtime", "POST", { requestedStart, requestedEnd, settlementKind: "pay", reason: "特殊日加班級距測試" });
      expect(overtime.status, await overtime.clone().text()).toBe(201);
      const overtimeId = (await overtime.json() as { id: string }).id;
      cookie = adminCookie;
      const reviewed = await request(`/hr/overtime/${overtimeId}/review`, "POST", { decision: "approved", comment: "核准" });
      expect(reviewed.status, await reviewed.clone().text()).toBe(200);
    }
    const payroll = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-09", attendanceMode: "all", employeeUserIds: ["dev-chen@ecotech.tw"], requestId: "test-payroll-special-overtime-rules" });
    expect(payroll.status, await payroll.clone().text()).toBe(200);
    const body = await payroll.json() as { run: { employees: Array<{ lines: Array<{ lineKey: string; amountMinor: number; explanation: Record<string, unknown> }> }> } };
    expect(body.run.employees[0]!.lines).toEqual(expect.arrayContaining([
      // 日薪 NT$1,800／日 ÷ 8 小時：前 2 小時 × 150%（NT$675）＋第 3 小時固定 NT$350。
      expect.objectContaining({ lineKey: "overtime", amountMinor: 102_500, explanation: expect.objectContaining({ formulaDetail: expect.stringContaining("特殊日固定時薪"), specialWorkdayRuleSnapshots: [expect.objectContaining({ workDate: "2026-09-03", overtimeRules: expect.arrayContaining([expect.objectContaining({ rateKind: "fixed_hourly", fixedAmountMinor: 35000 })]) })] }) }),
    ]));
  });

  it("特殊日零元級距仍保存加班規則快照", async () => {
    const compensation = await request("/hr/employments/dev-employment-chen/compensation", "POST", { validFrom: "2026-09-01", payBasis: "daily", baseAmountMinor: 180_000, note: "特殊日零元級距測試" });
    expect(compensation.status, await compensation.clone().text()).toBe(201);
    const ruleResponse = await request("/hr/special-workdays/rules", "POST", { name: "特殊日零元加班", validFrom: "2026-09-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, overtimeRules: [
      { fromHalfHours: 1, toHalfHours: null, rateKind: "fixed_hourly", fixedAmountMinor: 0 },
    ], allowances: [] });
    expect(ruleResponse.status, await ruleResponse.clone().text()).toBe(201);
    const versionId = (await ruleResponse.json() as { versionId: string }).versionId;
    const assigned = await request("/hr/special-workdays/assignments", "POST", { ruleVersionId: versionId, assignments: [{ employmentId: "dev-employment-chen", workDate: "2026-09-04", allowanceQuantity: 0 }] });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    const adminCookie = cookie;
    cookie = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id: "dev-chen@ecotech.tw", email: "chen@ecotech.tw", name: "陳美玲", pictureUrl: "" }), SECRET))}`;
    const overtime = await request("/hr/me/overtime", "POST", { requestedStart: "2026-09-04 18:00", requestedEnd: "2026-09-04 18:30", settlementKind: "pay", reason: "特殊日零元級距測試" });
    expect(overtime.status, await overtime.clone().text()).toBe(201);
    const overtimeId = (await overtime.json() as { id: string }).id;
    cookie = adminCookie;
    const reviewed = await request(`/hr/overtime/${overtimeId}/review`, "POST", { decision: "approved", comment: "核准" });
    expect(reviewed.status, await reviewed.clone().text()).toBe(200);
    const payroll = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-09", attendanceMode: "all", employeeUserIds: ["dev-chen@ecotech.tw"], requestId: "test-payroll-special-overtime-zero" });
    expect(payroll.status, await payroll.clone().text()).toBe(200);
    const body = await payroll.json() as { run: { employees: Array<{ lines: Array<{ lineKey: string; amountMinor: number; quantitySeconds?: number; explanation: Record<string, unknown> }> }> } };
    const overtimeLine = body.run.employees[0]!.lines.find((line) => line.lineKey === "overtime");
    expect(overtimeLine).toMatchObject({
      amountMinor: 0,
      quantitySeconds: 1800,
      explanation: expect.objectContaining({
        specialWorkdayRuleSnapshots: [expect.objectContaining({ workDate: "2026-09-04", ruleVersionId: versionId, overtimeRules: [expect.objectContaining({ rateKind: "fixed_hourly", fixedAmountMinor: 0 })] })],
      }),
    });
  });

  it("後端拒絕同一敘薪版本的重複薪資項目名稱", async () => {
    const response = await request("/hr/employments/dev-employment-chen/compensation", "POST", { validFrom: "2026-09-01", payBasis: "monthly", baseAmountMinor: 180_000, note: "重複項目測試", items: [
      { itemName: "交通津貼", amountMinor: 10_000, itemKind: "fixed", amountBasis: "monthly", includeOvertime: false, includeInsurance: false, includeTax: false },
      { itemName: " 交通津貼 ", amountMinor: 20_000, itemKind: "fixed", amountBasis: "monthly", includeOvertime: false, includeInsurance: false, includeTax: false },
    ] });
    expect(response.status, await response.clone().text()).toBe(400);
  });

  it("一般員工不能讀取薪資與獎金資料", async () => {
    cookie = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id: "dev-chen@ecotech.tw", email: "chen@ecotech.tw", name: "陳美玲", pictureUrl: "" }), SECRET))}`;
    expect((await request("/hr/bonus/policies")).status).toBe(403);
    expect((await request("/hr/payroll/runs/not-for-staff")).status).toBe(403);
    expect((await request("/hr/overview")).status).toBe(403);
  });

  it("缺少出金資料時提醒使用者，而不是默默把獎金算成 0", async () => {
    const db = createDatabase(d1 as never);
    // 只留兩天的出金：團體績效整月都要算，其餘 29 天就是「查不到業績」。
    await db.delete(reportPayoutDaily);
    await db.insert(reportPayoutDaily).values([
      { scopeId: "cyberbiz:store:demo-ximen", businessDate: "2026-08-01", recordOrigin: "manual" as const, reportRunId: null, payoutAmount: 180_000, updatedByEmail: "eli-lin@ecotech.tw" },
      { scopeId: "cyberbiz:store:demo-ximen", businessDate: "2026-08-03", recordOrigin: "manual" as const, reportRunId: null, payoutAmount: 195_000, updatedByEmail: "eli-lin@ecotech.tw" },
    ]);
    const payroll = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-08", attendanceMode: "scheduled", employeeUserIds: ["dev-wang@ecotech.tw"], requestId: "test-payroll-2026-08-wang-missing-payout" });
    expect(payroll.status, await payroll.clone().text()).toBe(200);
    const body = await payroll.json() as { run: { warnings: string[] } };
    expect(body.run.warnings.some((warning) => warning.includes("29 天缺少當月出金資料"))).toBe(true);
    expect(body.run.warnings.some((warning) => warning.includes("請先完成出金表匯入"))).toBe(true);
  });
});
