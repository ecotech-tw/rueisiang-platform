import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { desc, eq } from "drizzle-orm";
import { createDatabase, parseSpecialWorkdayAllowanceSnapshot, specialWorkdayAllowanceTotal, syncSystemRoles } from "@rueisiang/db";
import { activityEvents, hrInsuranceVersions, hrPayrollPeriods, hrPayrollRuns, hrSpecialWorkdayRuleVersions, userPermissionGrants, userRoleAssignments, users } from "@rueisiang/db/schema";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "hr-payroll-test-secret-test-secret";
let d1: LocalD1;
let cookies: Record<string, string>;

function healthDatasetMetadataResponse(distribution = [{
  resourceID: "A21030000I-B1000A-00G",
  resourceDescription: "115年1月全民健康保險投保金額分級表",
  format: "CSV",
}]) {
  return new Response(JSON.stringify({ distribution }));
}

async function request(path: string, method = "GET", payload?: Record<string, unknown>) {
  return app.fetch(new Request(`https://test.local/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookies.admin ?? "" },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  }), { DB: d1, AUTH_SESSION_SECRET: SECRET, GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" } as never);
}
/*
 * 這個檔案裡手動 insert 的 hrPayrollRuns 沒有索引列，也沒有「寫過索引」的標記——跟部署空窗時
 * 舊版 Worker 建立的批次一模一樣。保護仍然要成立，靠的是讀取前的補寫（indexMissingPayrollSpecialWorkdaySources）。
 */
async function assign(serviceStartOn = "2026-01-01") {
  const response = await request("/hr/employees", "POST", { userId: "employee", legalName: "薪資員工", employeeNumber: "E-PAY", position: "一般職員", serviceStartOn });
  expect(response.status, await response.clone().text()).toBe(201);
}
async function assignUser(userId: string, employeeNumber: string, serviceStartOn = "2026-01-01") {
  const response = await request("/hr/employees", "POST", { userId, legalName: `薪資${userId}`, employeeNumber, position: "一般職員", serviceStartOn });
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
      const url = String(input);
      if (url.includes("iode0010")) return healthDatasetMetadataResponse();
      if (url.includes("mol.gov.tw")) return new Response(JSON.stringify([
        { 適用起日: "1150101", 身分別: "一般勞工", 投保薪資等級: "1", 月薪資總額: "29500元以下", 月投保薪資: "29500" },
        { 適用起日: "1150101", 身分別: "一般勞工", 投保薪資等級: "2", 月薪資總額: "29501元至30300元", 月投保薪資: "30300" },
      ]));
      return new Response("組別級距,投保等級,月投保金額（元）,實際薪資月額（元）\n第一組,1,29500,29500元以下\n第二組,2,30300,29501-30300\n");
    });
    const response = await request("/hr/insurance-brackets?year=2026");
    expect(response.status).toBe(200);
    const body = await response.json() as { tables: { scheme: string; brackets: { insuredAmount: number; lowerSalary: number }[]; sourceUrl: string }[] };
    expect(body.tables).toHaveLength(2);
    expect(body.tables.find((table) => table.scheme === "labor")?.brackets[0]).toMatchObject({ insuredAmount: 29500, lowerSalary: 0, upperSalary: 29500 });
    expect(body.tables.find((table) => table.scheme === "labor")?.brackets[1]).toMatchObject({ insuredAmount: 30300, lowerSalary: 29501 });
    expect(body.tables.find((table) => table.scheme === "health")?.brackets[0]).toMatchObject({ insuredAmount: 29500, lowerSalary: 0, upperSalary: 29500 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain("https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-B1000A-00G");
    expect((await request("/hr/insurance-rates/sync", "POST", { year: 2026 })).status).toBe(201);
    expect((await request("/hr/insurance-rates/sync", "POST", { year: 2026 })).status).toBe(201);
    const synced = await (await request("/hr/insurance-rates?year=2026")).json() as { tables: { id: string; scheme: string; status: string; brackets: { employeeAmountMinor: number | null }[] }[] };
    expect(synced.tables.filter((table) => table.status === "draft")).toHaveLength(2);
    expect(synced.tables.find((table) => table.scheme === "labor" && table.status === "draft")?.brackets[0]?.employeeAmountMinor).toBe(73_800);
    expect(synced.tables.find((table) => table.scheme === "health" && table.status === "draft")?.brackets[0]?.employeeAmountMinor).toBe(45_800);
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

  it("勞保級距會納入基本工資以下的部分工時級距", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("iode0010")) return healthDatasetMetadataResponse();
      if (url.includes("mol.gov.tw")) return new Response(JSON.stringify([
        { 適用起日: "1150101", 身分別: "一般勞工", 投保薪資等級: "1", 月薪資總額: "29500元以下", 月投保薪資: "29500" },
        { 適用起日: "1150101", 身分別: "一般勞工", 投保薪資等級: "2", 月薪資總額: "29501元至30300元", 月投保薪資: "30300" },
        { 適用起日: "1150101", 身分別: "部分工時勞工", 投保薪資等級: "1", 月薪資總額: "11100元以下", 月投保薪資: "11100" },
        { 適用起日: "1150101", 身分別: "部分工時勞工", 投保薪資等級: "2", 月薪資總額: "11101元至12540元", 月投保薪資: "12540" },
        { 適用起日: "1150101", 身分別: "部分工時勞工", 投保薪資等級: "18", 月薪資總額: "28591元至29500元", 月投保薪資: "29500" },
      ]));
      return new Response("組別級距,投保等級,月投保金額（元）,實際薪資月額（元）\n第一組,1,29500,29500元以下\n");
    });
    const response = await request("/hr/insurance-brackets?year=2026");
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { tables: { scheme: string; brackets: { level: number; lowerSalary: number; upperSalary: number | null; insuredAmount: number }[] }[] };
    const labor = body.tables.find((table) => table.scheme === "labor")!;
    expect(labor.brackets).toEqual([
      { level: 1, lowerSalary: 0, upperSalary: 11100, insuredAmount: 11100 },
      { level: 2, lowerSalary: 11101, upperSalary: 12540, insuredAmount: 12540 },
      { level: 3, lowerSalary: 28591, upperSalary: 29500, insuredAmount: 29500 },
      { level: 4, lowerSalary: 29501, upperSalary: 30300, insuredAmount: 30300 },
    ]);
  });

  it("指定下一年度時使用官方資料的年度欄位與對應 resource", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("iode0010")) return healthDatasetMetadataResponse([
        { resourceID: "A21030000I-B1000A-00F", resourceDescription: "114年1月全民健康保險投保金額分級表", format: "CSV" },
        { resourceID: "A21030000I-B1000A-00G", resourceDescription: "115年1月全民健康保險投保金額分級表", format: "CSV" },
        { resourceID: "A21030000I-B1000A-00H", resourceDescription: "116年1月全民健康保險投保金額分級表", format: "CSV" },
      ]);
      if (url.includes("mol.gov.tw")) return new Response(JSON.stringify([
        { 適用起日: "1160101", 身分別: "一般勞工", 投保薪資等級: "1", 月薪資總額: "31300元以下", 月投保薪資: "31300" },
      ]));
      return new Response("組別級距,投保等級,月投保金額（元）,實際薪資月額（元）\n第一組,1,31300,31300元以下\n");
    });
    const response = await request("/hr/insurance-brackets?year=2027");
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { tables: { scheme: string; brackets: { insuredAmount: number }[] }[] };
    expect(body.tables.find((table) => table.scheme === "labor")?.brackets[0]?.insuredAmount).toBe(31300);
    expect(body.tables.find((table) => table.scheme === "health")?.brackets[0]?.insuredAmount).toBe(31300);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain("https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-B1000A-00H");
  });

  it("並行同步同一份官方級距只保留一份待審閱版本", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("iode0010")) return healthDatasetMetadataResponse();
      return url.includes("mol.gov.tw")
        ? new Response(JSON.stringify([{ 適用起日: "1150101", 身分別: "一般勞工", 投保薪資等級: "1", 月薪資總額: "29500元以下", 月投保薪資: "29500" }]))
        : new Response("組別級距,投保等級,月投保金額（元）,實際薪資月額（元）\n第一組,1,29500,29500元以下\n");
    });
    const responses = await Promise.all([
      request("/hr/insurance-rates/sync", "POST", { year: 2026 }),
      request("/hr/insurance-rates/sync", "POST", { year: 2026 }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const body = await (await request("/hr/insurance-rates?year=2026")).json() as { tables: { scheme: string; status: string }[] };
    expect(body.tables.filter((table) => table.status === "draft")).toHaveLength(2);
  });

  it("官方級距服務失敗時仍可人工建立、修改、啟用與刪除級距", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("service unavailable", { status: 503 }));
    const syncFailure = await request("/hr/insurance-rates/sync", "POST", { year: 2026 });
    expect(syncFailure.status, await syncFailure.clone().text()).toBe(502);
    const brackets = [
      { level: 1, lowerSalary: 0, upperSalary: 29500, insuredAmount: 29500 },
      { level: 2, lowerSalary: 29501, upperSalary: null, insuredAmount: 30300 },
    ];
    const created = await request("/hr/insurance-rates", "POST", { scheme: "labor", year: 2026, sourceUrl: "勞保 2026 公告", note: "人工覆核：官方服務暫時無法取得", brackets });
    expect(created.status, await created.clone().text()).toBe(201);
    const createdBody = await created.json() as { id: string };
    const listed = await (await request("/hr/insurance-rates?year=2026")).json() as { tables: Array<{ id: string; scheme: string; status: string; sourceKind: string; note: string; contentHash: string; brackets: typeof brackets }> };
    const draft = listed.tables.find((table) => table.id === createdBody.id)!;
    expect(draft).toMatchObject({ scheme: "labor", status: "draft", sourceKind: "manual", note: "人工覆核：官方服務暫時無法取得" });
    expect(draft.brackets).toHaveLength(brackets.length);
    expect(draft.brackets[0]).toMatchObject({ ...brackets[0], employeeAmountMinor: 73_800 });
    expect(draft.brackets[1]).toMatchObject({ ...brackets[1], employeeAmountMinor: 75_800 });

    const updated = await request(`/hr/insurance-rates/${createdBody.id}`, "PATCH", {
      sourceUrl: "勞保 2026 公告（修訂）", note: "人工覆核：已確認修訂版", contentHash: draft.contentHash,
      brackets: [brackets[0], { ...brackets[1], insuredAmount: 30400 }],
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const afterUpdate = await (await request("/hr/insurance-rates?year=2026")).json() as { tables: Array<{ id: string; contentHash: string; brackets: { insuredAmount: number; employeeAmountMinor: number | null }[] }> };
    const updatedDraft = afterUpdate.tables.find((table) => table.id === createdBody.id)!;
    expect(updatedDraft.brackets[1]?.insuredAmount).toBe(30400);
    expect(updatedDraft.brackets[1]?.employeeAmountMinor).toBe(76_000);
    expect(updatedDraft.contentHash).not.toBe(draft.contentHash);
    expect((await request(`/hr/insurance-rates/${createdBody.id}`, "PATCH", { sourceUrl: "過期版本", note: "過期", contentHash: draft.contentHash, brackets })).status).toBe(409);

    expect((await request(`/hr/insurance-rates/${createdBody.id}/activate`, "POST", { contentHash: draft.contentHash })).status).toBe(409);
    expect((await request(`/hr/insurance-rates/${createdBody.id}/activate`, "POST", { contentHash: updatedDraft.contentHash })).status).toBe(200);
    const active = await (await request("/hr/insurance-rates?year=2026")).json() as { tables: Array<{ id: string; status: string; sourceKind: string }> };
    expect(active.tables.find((table) => table.id === createdBody.id)).toMatchObject({ status: "active", sourceKind: "manual" });

    const next = await request("/hr/insurance-rates", "POST", { scheme: "labor", year: 2026, sourceUrl: "第二版", note: "待審閱刪除測試", brackets });
    expect(next.status, await next.clone().text()).toBe(201);
    const nextBody = await next.json() as { id: string };
    const nextListed = await (await request("/hr/insurance-rates?year=2026")).json() as { tables: Array<{ id: string; contentHash: string }> };
    const nextDraft = nextListed.tables.find((table) => table.id === nextBody.id)!;
    expect((await request(`/hr/insurance-rates/${nextBody.id}`, "DELETE", { contentHash: draft.contentHash })).status).toBe(409);
    expect((await request(`/hr/insurance-rates/${nextBody.id}`, "DELETE", { contentHash: nextDraft.contentHash })).status).toBe(200);
    const afterDelete = await (await request("/hr/insurance-rates?year=2026")).json() as { tables: Array<{ id: string }> };
    expect(afterDelete.tables.some((table) => table.id === nextBody.id)).toBe(false);
  });

  it("薪資與保險異動以版本保存，薪資更新可從實際異動日銜接", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-01", payBasis: "monthly", baseAmountMinor: 4000000, items: [{ itemName: "交通津貼", amountMinor: 300000, itemKind: "fixed", includeOvertime: true, includeInsurance: false, includeTax: true }] })).status).toBe(201);
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-03", payBasis: "monthly", baseAmountMinor: 4500000 })).status).toBe(201);
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-02", payBasis: "monthly", baseAmountMinor: 4600000 })).status).toBe(400);
    expect((await request(`/hr/employments/${employmentId}/insurance`, "POST", { versions: [{ scheme: "labor", status: "enrolled", validFrom: "2026-01-01", insuredAmountMinor: 4580000, dependentCount: 0, rateYear: 2026, sourceKind: "manual", note: "測試人工覆核投保金額" }] })).status).toBe(201);
    expect((await request(`/hr/employments/${employmentId}/insurance`, "POST", { versions: [{ scheme: "labor", status: "withdrawn", validFrom: "2026-03-01", insuredAmountMinor: 0, dependentCount: 0, rateYear: 2026, sourceKind: "manual" }] })).status).toBe(201);
    const detail = await (await request("/hr/employees/employee")).json() as { compensation: { baseAmountMinor: number; items?: { itemName: string; includeOvertime: number }[] }[]; insurance: { status: string; validFrom: string; validTo: string | null }[] };
    expect(detail.compensation.find((item) => item.baseAmountMinor === 4000000)?.items).toEqual([expect.objectContaining({ itemName: "交通津貼", includeOvertime: 1 })]);
    expect(detail.compensation).toEqual(expect.arrayContaining([
      expect.objectContaining({ baseAmountMinor: 4500000, validFrom: "2026-01-03", validTo: null }),
      expect.objectContaining({ baseAmountMinor: 4000000, validFrom: "2026-01-01", validTo: "2026-01-03" }),
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
    const first = beforeVoid.compensation.find((version) => version.baseAmountMinor === 4000000)!;
    expect((await request(`/hr/employments/${employmentId}/compensation/${first.id}/void`, "POST", {})).status).toBe(409);
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

  it("可以依序撤回最新版本直到第一版，再建立第一版修正版", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    const path = `/hr/employments/${employmentId}/compensation`;
    expect((await request(path, "POST", { validFrom: "2026-01-01", validTo: "2026-01-02", payBasis: "monthly", baseAmountMinor: 4000000 })).status).toBe(201);
    expect((await request(path, "POST", { validFrom: "2026-01-02", validTo: "2026-01-03", payBasis: "monthly", baseAmountMinor: 4500000 })).status).toBe(201);
    expect((await request(path, "POST", { validFrom: "2026-01-03", payBasis: "monthly", baseAmountMinor: 4600000 })).status).toBe(201);

    const before = await (await request("/hr/employees/employee")).json() as { compensation: Array<{ id: string; validFrom: string; baseAmountMinor: number; voidedAt: string | null }> };
    for (const amount of [4600000, 4500000, 4000000]) {
      const version = before.compensation.find((item) => item.baseAmountMinor === amount)!;
      const response = await request(`${path}/${version.id}/void`, "POST", {});
      expect(response.status, await response.clone().text()).toBe(200);
    }

    const afterVoid = await (await request("/hr/employees/employee")).json() as { compensation: Array<{ id: string; validFrom: string; baseAmountMinor: number; voidedAt: string | null }> };
    expect(afterVoid.compensation.filter((version) => version.voidedAt)).toHaveLength(3);
    const first = afterVoid.compensation.find((version) => version.baseAmountMinor === 4000000)!;
    expect((await request(`${path}/${first.id}/void`, "POST", {})).status).toBe(409);

    expect((await request(path, "POST", { validFrom: "2026-01-03", validTo: "2026-01-04", payBasis: "monthly", baseAmountMinor: 4200000 })).status).toBe(201);
    const afterReplacement = await (await request("/hr/employees/employee")).json() as { compensation: Array<{ validFrom: string; baseAmountMinor: number; voidedAt: string | null }> };
    expect(afterReplacement.compensation).toEqual(expect.arrayContaining([
      expect.objectContaining({ validFrom: "2026-01-01", baseAmountMinor: 4000000, voidedAt: expect.any(String) }),
      expect.objectContaining({ validFrom: "2026-01-03", baseAmountMinor: 4200000, voidedAt: null }),
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

  it("最新勞健保版本可依序撤回到第一版並在原生效日建立修正版", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    const path = `/hr/employments/${employmentId}/insurance`;
    const version = (scheme: "labor" | "health", validFrom: string, insuredAmountMinor: number) => ({ scheme, status: "enrolled", validFrom, insuredAmountMinor, dependentCount: scheme === "health" ? 1 : 0, rateYear: 2026, sourceKind: "manual", note: "測試投保" });
    const detail = async () => (await (await request("/hr/employees/employee")).json() as { insurance: Array<{ id: string; scheme: string; validFrom: string; validTo: string | null; voidedAt: string | null; voidedBy: string | null }> }).insurance;

    expect((await request(path, "POST", { versions: [version("labor", "2026-01-01", 3_000_000), version("health", "2026-01-01", 3_000_000)] })).status).toBe(201);
    expect((await request(path, "POST", { versions: [version("labor", "2026-02-01", 3_500_000), version("health", "2026-02-01", 3_500_000)] })).status).toBe(201);
    const beforeVoid = await detail();
    const latest = beforeVoid.filter((item) => item.validFrom === "2026-02-01");
    const first = beforeVoid.filter((item) => item.validFrom === "2026-01-01");
    expect(latest).toHaveLength(2);
    expect(first).toHaveLength(2);
    expect((await request(`${path}/${first[0]!.id}/void`, "POST", {})).status).toBe(409);
    // 舊 migration 建立的版本沒有 superseded metadata，撤回不能從 validTo 猜測前一版原本是否開放。
    const db = createDatabase(d1 as never);
    for (const item of first) await db.update(hrInsuranceVersions).set({ supersededValidTo: null, supersededByVersionId: null }).where(eq(hrInsuranceVersions.id, item.id));

    const voided = await request(`/hr/employments/${employmentId}/insurance/void`, "POST", { versionIds: latest.map((item) => item.id) });
    expect(voided.status, await voided.clone().text()).toBe(200);
    const afterLatestVoid = await detail();
    expect(afterLatestVoid).toEqual(expect.arrayContaining([
      expect.objectContaining({ validFrom: "2026-02-01", voidedAt: expect.any(String), voidedBy: "admin" }),
      expect.objectContaining({ validFrom: "2026-01-01", validTo: "2026-02-01", voidedAt: null }),
    ]));

    expect((await request(path, "POST", { versions: [version("labor", "2026-02-01", 3_600_000), version("health", "2026-02-01", 3_600_000)] })).status).toBe(201);
    const beforeFirstVoid = await detail();
    const replacement = beforeFirstVoid.filter((item) => item.validFrom === "2026-02-01" && !item.voidedAt);
    const original = beforeFirstVoid.filter((item) => item.validFrom === "2026-01-01");
    expect(replacement).toHaveLength(2);
    expect((await request(`/hr/employments/${employmentId}/insurance/void`, "POST", { versionIds: replacement.map((item) => item.id) })).status).toBe(200);
    expect((await request(`/hr/employments/${employmentId}/insurance/void`, "POST", { versionIds: original.map((item) => item.id) })).status).toBe(200);
    expect((await detail()).filter((item) => item.voidedAt)).toHaveLength(6);

    expect((await request(path, "POST", { versions: [version("labor", "2026-01-01", 3_700_000), version("health", "2026-01-01", 3_700_000)] })).status).toBe(201);
  });

  it("缺少撤回 metadata 時不會延長明確結束的前一版", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    const path = `/hr/employments/${employmentId}/insurance`;
    expect((await request(path, "POST", { versions: [{ scheme: "labor", status: "enrolled", validFrom: "2026-01-01", validTo: "2026-02-01", insuredAmountMinor: 3_000_000, dependentCount: 0, rateYear: 2026, sourceKind: "manual", note: "測試明確迄日" }] })).status).toBe(201);
    expect((await request(path, "POST", { versions: [{ scheme: "labor", status: "enrolled", validFrom: "2026-02-01", validTo: null, insuredAmountMinor: 3_500_000, dependentCount: 0, rateYear: 2026, sourceKind: "manual", note: "測試後續版本" }] })).status).toBe(201);
    const beforeVoid = await (await request("/hr/employees/employee")).json() as { insurance: Array<{ id: string; validFrom: string; validTo: string | null }> };
    const latest = beforeVoid.insurance.find((version) => version.validFrom === "2026-02-01")!;
    const voided = await request(`/hr/employments/${employmentId}/insurance/${latest.id}/void`, "POST", {});
    expect(voided.status, await voided.clone().text()).toBe(200);
    const afterVoid = await (await request("/hr/employees/employee")).json() as { insurance: Array<{ validFrom: string; validTo: string | null }> };
    expect(afterVoid.insurance).toEqual(expect.arrayContaining([
      expect.objectContaining({ validFrom: "2026-01-01", validTo: "2026-02-01" }),
    ]));
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

  it("尚未到職的員工不會阻擋薪資期間結帳", async () => {
    const db = createDatabase(d1 as never);
    await db.insert(users).values({ id: "future-employee", email: "future-employee@example.test", displayName: "未到職員工", status: "active" });
    await assign("2026-01-01");
    await assignUser("future-employee", "E-FUTURE", "2026-02-01");
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    expect((await request(`/hr/employments/${profile.employments[0]!.id}/compensation`, "POST", { validFrom: "2026-01-01", payBasis: "monthly", baseAmountMinor: 3_000_000 })).status).toBe(201);
    const calculated = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-01", employeeUserIds: ["employee"], requestId: "future-employee-does-not-block" });
    expect(calculated.status, await calculated.clone().text()).toBe(200);
    const runId = (await calculated.json() as { run: { runId: string } }).run.runId;
    expect((await request(`/hr/payroll/runs/${runId}/close`, "POST", {})).status).toBe(200);
  });

  it("待啟用員工也必須 claim 後才能關閉薪資期間", async () => {
    const db = createDatabase(d1 as never);
    await db.insert(users).values({ id: "invited-claim", email: "invited-claim@example.test", displayName: "待啟用員工", status: "invited" });
    await assign("2026-01-01");
    await assignUser("invited-claim", "E-INVITED-CLAIM", "2026-01-01");
    const firstProfile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const secondProfile = await (await request("/hr/employees/invited-claim")).json() as { employments: { id: string }[] };
    for (const employmentId of [firstProfile.employments[0]!.id, secondProfile.employments[0]!.id]) {
      expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-01", payBasis: "monthly", baseAmountMinor: 3_000_000 })).status).toBe(201);
    }
    const first = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-01", employeeUserIds: ["employee"], requestId: "invited-claim-first" });
    expect(first.status, await first.clone().text()).toBe(200);
    const firstRunId = (await first.json() as { run: { runId: string } }).run.runId;
    expect((await request(`/hr/payroll/runs/${firstRunId}/close`, "POST", {})).status).toBe(200);
    const second = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-01", employeeUserIds: ["invited-claim"], requestId: "invited-claim-second" });
    expect(second.status, await second.clone().text()).toBe(200);
    const secondRunId = (await second.json() as { run: { runId: string } }).run.runId;
    expect((await request(`/hr/payroll/runs/${secondRunId}/close`, "POST", {})).status).toBe(200);
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

  it("移除來源月份後，既有含薪資加扣項的試算仍可結帳", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-01", payBasis: "monthly", baseAmountMinor: 3_000_000 })).status).toBe(201);
    const adjustment = await request("/hr/payroll/adjustments", "POST", { employmentId, effectivePeriodKey: "2026-01", reason: "舊版加扣項", items: [{ itemName: "舊版補發", amountMinor: 100 }] });
    expect(adjustment.status, await adjustment.clone().text()).toBe(201);
    const calculated = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-01", employeeUserIds: ["employee"], requestId: "legacy-adjustment-snapshot" });
    expect(calculated.status, await calculated.clone().text()).toBe(200);
    const runId = (await calculated.json() as { run: { runId: string } }).run.runId;
    const row = d1.sqlite.prepare("SELECT source_snapshot_json AS snapshot FROM hr_payroll_runs WHERE id=?").get(runId) as { snapshot: string };
    const snapshot = JSON.parse(row.snapshot) as { adjustments: Array<Record<string, unknown>> };
    snapshot.adjustments[0]!.sourcePeriodKey = "2025-12";
    d1.sqlite.prepare("UPDATE hr_payroll_runs SET source_snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot), runId);
    const closed = await request(`/hr/payroll/runs/${runId}/close`, "POST", {});
    expect(closed.status, await closed.clone().text()).toBe(200);
  });

  it("特殊上班日套用只關聯規則，允許零補貼且阻擋重複套用", async () => {
    await assign();
    await assignUser("admin", "E-ADMIN");
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const adminProfile = await (await request("/hr/employees/admin")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    const adminEmploymentId = adminProfile.employments[0]!.id;
    const invalid = await request("/hr/special-workdays/rules", "POST", { name: "不連續特殊日", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, overtimeRules: [{ fromHalfHours: 2, toHalfHours: null, rateKind: "multiplier", multiplierPpm: 1_500_000 }], allowances: [] });
    expect(invalid.status, await invalid.clone().text()).toBe(400);
    const duplicateAllowance = await request("/hr/special-workdays/rules", "POST", { name: "重複補貼名稱", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, overtimeRules: [], allowances: [{ itemName: "餐費", unitAmountMinor: 0 }, { itemName: " 餐費 ", unitAmountMinor: 100 }] });
    expect(duplicateAllowance.status, await duplicateAllowance.clone().text()).toBe(400);
    const created = await request("/hr/special-workdays/rules", "POST", { name: "測試國定日", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, overtimeRules: [{ fromHalfHours: 1, toHalfHours: 4, rateKind: "multiplier", multiplierPpm: 1_500_000 }, { fromHalfHours: 5, toHalfHours: null, rateKind: "fixed_hourly", fixedAmountMinor: 35000 }], allowances: [{ itemName: "餐費", unitAmountMinor: 0 }, { itemName: "交通補貼", unitAmountMinor: 12000 }] });
    expect(created.status, await created.clone().text()).toBe(201);
    const createdBody = await created.json() as { id: string; versionId: string };
    const listed = await (await request("/hr/special-workdays/rules")).json() as { rules: Array<{ rule: { name: string }; versions: Array<{ id: string; workSource: string; note: string; allowances: Array<{ id: string; itemName: string; unitAmountMinor: number }>; overtimeRules: Array<{ fromHalfHours: number; toHalfHours: number | null; rateKind: string; fixedAmountMinor: number | null; multiplierPpm: number | null }> }> }> };
    expect(listed.rules).toEqual(expect.arrayContaining([expect.objectContaining({ rule: expect.objectContaining({ name: "測試國定日" }), versions: [expect.objectContaining({ id: createdBody.versionId, workSource: "hourly", note: "", overtimeRules: [expect.objectContaining({ fromHalfHours: 1, toHalfHours: 4, rateKind: "multiplier", multiplierPpm: 1_500_000 }), expect.objectContaining({ fromHalfHours: 5, toHalfHours: null, rateKind: "fixed_hourly", fixedAmountMinor: 35000 })], allowances: [expect.objectContaining({ itemName: "餐費", unitAmountMinor: 0 }), expect.objectContaining({ itemName: "交通補貼", unitAmountMinor: 12000 })] })] })]));
    const assigned = await request("/hr/special-workdays/assignments", "POST", { ruleId: createdBody.id, assignments: [{ employmentId, workDate: "2026-02-28", allowanceQuantity: 0 }] });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    const legacyAssigned = await request("/hr/special-workdays/assignments", "POST", { ruleVersionId: createdBody.versionId, assignments: [{ employmentId: adminEmploymentId, workDate: "2026-02-27", allowanceQuantity: 0 }] });
    expect(legacyAssigned.status, await legacyAssigned.clone().text()).toBe(201);
    const versionAllowances = listed.rules.flatMap((rule) => rule.versions).find((version) => version.id === createdBody.versionId)!.allowances;
    const workerResponse = await request("/hr/schedule-workers", "POST", { displayName: "支援測試" });
    expect(workerResponse.status, await workerResponse.clone().text()).toBe(201);
    const workerId = (await workerResponse.json() as { id: string }).id;
    const allowanceQuantities = [{ allowanceId: versionAllowances[0]!.id, quantity: 1 }, { allowanceId: versionAllowances[1]!.id, quantity: 3 }];
    const bulkAssigned = await request("/hr/special-workdays/assignments", "POST", { ruleId: createdBody.id, assignments: [{ employmentId, workDate: "2026-03-01", allowanceQuantities }, { employmentId: adminEmploymentId, workDate: "2026-03-01", allowanceQuantities }, { workerId, workDate: "2026-03-01", allowanceQuantities }] });
    expect(bulkAssigned.status, await bulkAssigned.clone().text()).toBe(201);
    const assignmentRows = await (await request("/hr/special-workdays/assignments?start=2026-03-01&end=2026-03-02")).json() as { assignments: Array<{ assignment: { allowanceSnapshotJson: string } }> };
    expect(assignmentRows.assignments).toHaveLength(3);
    for (const row of assignmentRows.assignments) expect(JSON.parse(row.assignment.allowanceSnapshotJson)).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemName: "餐費", quantity: 1 }), expect.objectContaining({ itemName: "交通補貼", quantity: 3 }),
    ]));
    expect((await request("/hr/special-workdays/assignments?start=2026-02-01&end=2026-03-01")).status).toBe(200);
    expect((await request("/hr/special-workdays/assignments", "POST", { ruleId: createdBody.id, assignments: [{ employmentId, workDate: "2026-02-28", allowanceQuantity: 0 }] })).status).toBe(409);
  });

  it("特殊上班日套用依日期使用有效版本，沒有有效期間時拒絕", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    const first = await request("/hr/special-workdays/rules", "POST", { name: "依日期選版特殊日", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, overtimeRules: [], allowances: [] });
    expect(first.status, await first.clone().text()).toBe(201);
    const firstBody = await first.json() as { id: string; versionId: string };
    const second = await request(`/hr/special-workdays/rules/${firstBody.id}/versions`, "POST", { name: "依日期選版特殊日", validFrom: "2026-06-01", validTo: "2026-07-01", wageKind: "fixed_hourly", fixedAmountMinor: 35000, overtimeRules: [], allowances: [] });
    expect(second.status, await second.clone().text()).toBe(201);
    const secondBody = await second.json() as { versionId: string };
    expect((await request("/hr/special-workdays/assignments", "POST", { ruleId: firstBody.id, assignments: [{ employmentId, workDate: "2026-05-31", allowanceQuantity: 0 }] })).status).toBe(201);
    expect((await request("/hr/special-workdays/assignments", "POST", { ruleId: firstBody.id, assignments: [{ employmentId, workDate: "2026-06-01", allowanceQuantity: 0 }] })).status).toBe(201);
    const listed = await (await request("/hr/special-workdays/assignments?start=2026-05-31&end=2026-06-02")).json() as { assignments: Array<{ assignment: { workDate: string }; currentVersionNumber: number | null }> };
    expect(listed.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ assignment: expect.objectContaining({ workDate: "2026-05-31" }), currentVersionNumber: 1 }),
      expect.objectContaining({ assignment: expect.objectContaining({ workDate: "2026-06-01" }), currentVersionNumber: 2 }),
    ]));
    const expired = await request("/hr/special-workdays/assignments", "POST", { ruleId: firstBody.id, assignments: [{ employmentId, workDate: "2026-07-01", allowanceQuantity: 0 }] });
    expect(expired.status, await expired.clone().text()).toBe(409);
    expect(secondBody.versionId).not.toBe(firstBody.versionId);
  });

  it("已套用的特殊上班日可以調整人員、日期與補貼數量", async () => {
    await assign();
    await assignUser("admin", "E-ADMIN");
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const adminProfile = await (await request("/hr/employees/admin")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    const adminEmploymentId = adminProfile.employments[0]!.id;
    const created = await request("/hr/special-workdays/rules", "POST", { name: "可調整特殊日", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, overtimeRules: [], allowances: [{ itemName: "餐費", unitAmountMinor: 10000 }] });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id: ruleId } = await created.json() as { id: string };
    const replacement = await request("/hr/special-workdays/rules", "POST", { name: "可調整另一規則", validFrom: "2026-01-01", wageKind: "multiplier", multiplierPpm: 1_500_000, overtimeRules: [], allowances: [{ itemName: "餐費", unitAmountMinor: 12000 }] });
    expect(replacement.status, await replacement.clone().text()).toBe(201);
    const { id: replacementRuleId } = await replacement.json() as { id: string };
    const listedRules = await (await request("/hr/special-workdays/rules")).json() as { rules: Array<{ rule: { id: string }; versions: Array<{ allowances: Array<{ id: string }> }> }> };
    const allowanceId = listedRules.rules.find((item) => item.rule.id === ruleId)!.versions[0]!.allowances[0]!.id;
    const replacementAllowanceId = listedRules.rules.find((item) => item.rule.id === replacementRuleId)!.versions[0]!.allowances[0]!.id;
    const assigned = await request("/hr/special-workdays/assignments", "POST", { ruleId, assignments: [{ employmentId, workDate: "2026-04-01", allowanceQuantities: [{ allowanceId, quantity: 1 }] }] });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    const before = await (await request("/hr/special-workdays/assignments")).json() as { assignments: Array<{ assignment: { id: string } }> };
    const assignmentId = before.assignments[0]!.assignment.id;

    const updated = await request(`/hr/special-workdays/assignments/${assignmentId}`, "PATCH", { ruleId: replacementRuleId, employmentId: adminEmploymentId, workDate: "2026-04-02", allowanceQuantities: [{ allowanceId: replacementAllowanceId, quantity: 3 }] });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await updated.json()).toMatchObject({ id: assignmentId, ruleId: replacementRuleId });
    const after = await (await request("/hr/special-workdays/assignments")).json() as { assignments: Array<{ assignment: { id: string; ruleId: string; employmentId: string | null; workDate: string; allowanceSnapshotJson: string } }> };
    expect(after.assignments).toEqual([expect.objectContaining({ assignment: expect.objectContaining({ id: assignmentId, ruleId: replacementRuleId, employmentId: adminEmploymentId, workDate: "2026-04-02", allowanceSnapshotJson: JSON.stringify([{ itemName: "餐費", unitAmountMinor: 12000, quantity: 3 }]) }) })]);

    const second = await request("/hr/special-workdays/assignments", "POST", { ruleId, assignments: [{ employmentId, workDate: "2026-04-03", allowanceQuantities: [{ allowanceId, quantity: 0 }] }] });
    expect(second.status, await second.clone().text()).toBe(201);
    const secondRows = await (await request("/hr/special-workdays/assignments")).json() as { assignments: Array<{ assignment: { id: string; employmentId: string | null } }> };
    const secondId = secondRows.assignments.find((item) => item.assignment.employmentId === employmentId)!.assignment.id;
    const duplicate = await request(`/hr/special-workdays/assignments/${secondId}`, "PATCH", { ruleId: replacementRuleId, employmentId: adminEmploymentId, workDate: "2026-04-02", allowanceQuantities: [{ allowanceId: replacementAllowanceId, quantity: 0 }] });
    expect(duplicate.status, await duplicate.clone().text()).toBe(409);
  });

  it("特殊上班日不能套用或編輯到停用帳號", async () => {
    await assign();
    const db = createDatabase(d1 as never);
    await db.insert(users).values({ id: "disabled-employee", email: "disabled-employee@example.test", displayName: "停用員工", status: "active" });
    await assignUser("disabled-employee", "E-DISABLED");
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, "disabled-employee"));
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const disabledProfile = await (await request("/hr/employees/disabled-employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    const disabledEmploymentId = disabledProfile.employments[0]!.id;
    const created = await request("/hr/special-workdays/rules", "POST", { name: "停用帳號特殊日", validFrom: "2026-01-01", wageKind: "multiplier", multiplierPpm: 1_500_000, overtimeRules: [], allowances: [] });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id: ruleId } = await created.json() as { id: string };
    const rejectedCreate = await request("/hr/special-workdays/assignments", "POST", { ruleId, assignments: [{ employmentId: disabledEmploymentId, workDate: "2026-04-01", allowanceQuantities: [] }] });
    expect(rejectedCreate.status, await rejectedCreate.clone().text()).toBe(400);
    const assigned = await request("/hr/special-workdays/assignments", "POST", { ruleId, assignments: [{ employmentId, workDate: "2026-04-01", allowanceQuantities: [] }] });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    const rows = await (await request("/hr/special-workdays/assignments")).json() as { assignments: Array<{ assignment: { id: string } }> };
    const rejectedUpdate = await request(`/hr/special-workdays/assignments/${rows.assignments[0]!.assignment.id}`, "PATCH", { ruleId, employmentId: disabledEmploymentId, workDate: "2026-04-02", allowanceQuantities: [] });
    expect(rejectedUpdate.status, await rejectedUpdate.clone().text()).toBe(400);
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, "employee"));
    const rejectedDateUpdate = await request(`/hr/special-workdays/assignments/${rows.assignments[0]!.assignment.id}`, "PATCH", { ruleId, employmentId, workDate: "2026-04-03", allowanceQuantities: [] });
    expect(rejectedDateUpdate.status, await rejectedDateUpdate.clone().text()).toBe(400);
  });

  it("出勤設定讀取權限可以取得支援人員名單", async () => {
    const worker = await request("/hr/schedule-workers", "POST", { displayName: "特殊日支援名單" });
    expect(worker.status, await worker.clone().text()).toBe(201);
    const adminCookie = cookies.admin!;
    const db = createDatabase(d1 as never);
    await db.insert(users).values({ id: "office-reader", email: "office-reader@example.test", displayName: "出勤設定讀取者", status: "active" });
    await db.insert(userPermissionGrants).values({ userId: "office-reader", permission: "hr:office:read" });
    cookies = { admin: `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id: "office-reader", email: "office-reader@example.test", name: "出勤設定讀取者", pictureUrl: "" }), SECRET))}` };
    const listed = await request("/hr/schedule-workers");
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect((await listed.json() as { workers: Array<{ displayName: string }> }).workers).toEqual(expect.arrayContaining([expect.objectContaining({ displayName: "特殊日支援名單" })]));
    cookies = { admin: adminCookie };
  });

  it("特殊上班日可以一次套用超過一百人，不會超過 D1 的綁定參數上限", async () => {
    const created = await request("/hr/special-workdays/rules", "POST", { name: "大批套用", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, overtimeRules: [], allowances: [] });
    expect(created.status, await created.clone().text()).toBe(201);
    const ruleId = (await created.json() as { id: string }).id;
    const firstWorker = await request("/hr/schedule-workers", "POST", { displayName: "支援 0" });
    expect(firstWorker.status, await firstWorker.clone().text()).toBe(201);
    const workerIds = [(await firstWorker.json() as { id: string }).id];
    // 其餘的直接寫進資料庫：走 API 建一百多位會把測試時間花在跟這個案例無關的地方。
    const insertEmployment = d1.sqlite.prepare("INSERT INTO hr_employments (id, person_kind, employee_number, legal_name, position) VALUES (?, 'worker', ?, ?, '支援人員')");
    const insertWorker = d1.sqlite.prepare("INSERT INTO hr_schedule_workers (id, employment_id, display_name, created_by) SELECT ?, ?, ?, created_by FROM hr_schedule_workers WHERE id = ?");
    for (let index = 1; index < 120; index += 1) {
      const id = `bulk-worker-${index}`;
      const name = `支援 ${index}`;
      insertEmployment.run(id, `W-${id}`, name);
      insertWorker.run(id, id, name, workerIds[0]!);
      workerIds.push(id);
    }
    const assignments = workerIds.map((workerId) => ({ workerId, workDate: "2026-03-01", allowanceQuantities: [] }));

    // 本機的 D1 替身照 D1 的規格擋 100 個綁定參數；ID 清單退回一個 ID 一個參數的寫法時這裡會 500。
    const assigned = await request("/hr/special-workdays/assignments", "POST", { ruleId, assignments });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    const rows = await (await request("/hr/special-workdays/assignments?start=2026-03-01&end=2026-03-02")).json() as { assignments: unknown[] };
    expect(rows.assignments).toHaveLength(120);
    // 清單再長，排在後面的人一樣要擋得到重複。
    expect((await request("/hr/special-workdays/assignments", "POST", { ruleId, assignments: [assignments[119]!] })).status).toBe(409);
  });

  it("特殊上班日舊快照沒有逐項數量時沿用舊共用數量", () => {
    const legacySnapshot = JSON.stringify([{ itemName: "餐費", unitAmountMinor: 1_000 }, { itemName: "交通補貼", unitAmountMinor: 1_200 }]);
    expect(parseSpecialWorkdayAllowanceSnapshot(legacySnapshot, 2)).toEqual([
      { itemName: "餐費", unitAmountMinor: 1_000, quantity: 2 }, { itemName: "交通補貼", unitAmountMinor: 1_200, quantity: 2 },
    ]);
    expect(specialWorkdayAllowanceTotal(legacySnapshot, 2)).toBe(4_400);
  });

  it("特殊上班日最新版本解除後回到建立前的狀態，日期套用跟隨目前規則", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    const first = await request("/hr/special-workdays/rules", "POST", { name: "可解除特殊日", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, allowances: [], overtimeRules: [] });
    expect(first.status, await first.clone().text()).toBe(201);
    const firstBody = await first.json() as { id: string; versionId: string };
    const second = await request(`/hr/special-workdays/rules/${firstBody.id}/versions`, "POST", { name: "可解除特殊日", validFrom: "2026-02-01", wageKind: "fixed_hourly", fixedAmountMinor: 35000, allowances: [], overtimeRules: [] });
    expect(second.status, await second.clone().text()).toBe(201);
    const secondBody = await second.json() as { versionId: string; versionNumber: number };
    expect(secondBody.versionNumber).toBe(2);
    expect((await request("/hr/special-workdays/assignments", "POST", { ruleId: firstBody.id, assignments: [{ employmentId, workDate: "2026-02-20", allowanceQuantity: 0 }] })).status).toBe(201);

    expect((await request(`/hr/special-workdays/rules/${firstBody.id}/versions/${firstBody.versionId}/void`, "POST", {})).status).toBe(409);
    const voided = await request(`/hr/special-workdays/rules/${firstBody.id}/versions/${secondBody.versionId}/void`, "POST", {});
    expect(voided.status, await voided.clone().text()).toBe(200);
    expect(await voided.json()).toMatchObject({ ruleId: firstBody.id, versionId: secondBody.versionId, previousVersionId: firstBody.versionId, status: "voided" });

    const listed = await (await request("/hr/special-workdays/rules")).json() as { rules: Array<{ rule: { id: string }; versions: Array<{ id: string; versionNumber: number; validTo: string | null; voidedAt: string | null; voidedBy: string | null }> }> };
    const versions = listed.rules.find((item) => item.rule.id === firstBody.id)!.versions;
    expect(versions).toEqual([expect.objectContaining({ id: firstBody.versionId, versionNumber: 1, validTo: null, voidedAt: null })]);
    const [voidEvent] = await createDatabase(d1 as never).select({ summary: activityEvents.summary, entityLabel: activityEvents.entityLabel, payloadJson: activityEvents.payloadJson }).from(activityEvents).where(eq(activityEvents.eventType, "special_workday_rule_version_voided")).orderBy(desc(activityEvents.createdAt)).limit(1);
    expect(voidEvent).toMatchObject({ summary: "特殊上班日規則版本解除", entityLabel: "可解除特殊日" });
    expect(JSON.parse(voidEvent!.payloadJson)).toMatchObject({ voidedVersion: { versionId: secondBody.versionId, versionNumber: 2, validFrom: "2026-02-01", fixedAmountMinor: 35000, removed: true }, restoredVersionId: firstBody.versionId });
    expect((await request(`/hr/special-workdays/rules/${firstBody.id}/versions/${firstBody.versionId}/void`, "POST", {})).status).toBe(409);
    expect((await request("/hr/special-workdays/assignments", "POST", { ruleId: firstBody.id, assignments: [{ employmentId, workDate: "2026-02-21", allowanceQuantity: 0 }] })).status).toBe(201);
    const assignmentRows = await (await request("/hr/special-workdays/assignments?start=2026-02-01&end=2026-03-01")).json() as { assignments: Array<{ assignment: { ruleId: string }; currentVersionNumber: number | null; currentVersionVoidedAt: string | null }> };
    expect(assignmentRows.assignments).toEqual(expect.arrayContaining([expect.objectContaining({ assignment: expect.objectContaining({ ruleId: firstBody.id }), currentVersionNumber: 1, currentVersionVoidedAt: null })]));

    const rebuilt = await request(`/hr/special-workdays/rules/${firstBody.id}/versions`, "POST", { name: "可解除特殊日", validFrom: "2026-02-01", wageKind: "fixed_hourly", fixedAmountMinor: 45000, allowances: [], overtimeRules: [] });
    expect(rebuilt.status, await rebuilt.clone().text()).toBe(201);
    expect(await rebuilt.json()).toMatchObject({ versionNumber: 2 });
  });

  it("已有薪資依據的特殊上班日版本解除後保留來源，不會被清掉", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const first = await request("/hr/special-workdays/rules", "POST", { name: "薪資用過的版本", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, allowances: [], overtimeRules: [] });
    expect(first.status, await first.clone().text()).toBe(201);
    const firstBody = await first.json() as { id: string; versionId: string };
    const second = await request(`/hr/special-workdays/rules/${firstBody.id}/versions`, "POST", { name: "薪資用過的版本", validFrom: "2026-04-01", wageKind: "fixed_hourly", fixedAmountMinor: 35000, allowances: [{ itemName: "餐費", unitAmountMinor: 10000 }], overtimeRules: [] });
    expect(second.status, await second.clone().text()).toBe(201);
    const secondBody = await second.json() as { versionId: string };
    expect((await request("/hr/special-workdays/assignments", "POST", { ruleId: firstBody.id, assignments: [{ employmentId: profile.employments[0]!.id, workDate: "2026-04-03", allowanceQuantities: [] }] })).status).toBe(201);
    const listedAssignments = await (await request("/hr/special-workdays/assignments")).json() as { assignments: Array<{ assignment: { id: string; ruleId: string } }> };
    const assignmentId = listedAssignments.assignments.find((item) => item.assignment.ruleId === firstBody.id)!.assignment.id;
    const db = createDatabase(d1 as never);
    await db.insert(hrPayrollPeriods).values({ id: "payroll-period-void-kept", periodKey: "2026-04", attendanceStart: "2026-04-01", attendanceEnd: "2026-05-01", createdBy: "admin" });
    await db.insert(hrPayrollRuns).values({ id: "payroll-run-void-kept", payrollPeriodId: "payroll-period-void-kept", versionNumber: 1, requestId: "payroll-request-void-kept", inputRevision: 1, sourceSnapshotJson: JSON.stringify({ specialWorkdays: [{ id: assignmentId }] }), engineVersion: "test", status: "ready", expectedCount: 0, completedCount: 0, createdBy: "admin" });

    const voided = await request(`/hr/special-workdays/rules/${firstBody.id}/versions/${secondBody.versionId}/void`, "POST", {});
    expect(voided.status, await voided.clone().text()).toBe(200);
    const listed = await (await request("/hr/special-workdays/rules")).json() as { rules: Array<{ rule: { id: string }; versions: Array<{ id: string; validTo: string | null; voidedAt: string | null; allowances: unknown[] }> }> };
    expect(listed.rules.find((item) => item.rule.id === firstBody.id)!.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstBody.versionId, validTo: null, voidedAt: null }),
      expect.objectContaining({ id: secondBody.versionId, voidedAt: expect.any(String), allowances: [expect.objectContaining({ itemName: "餐費" })] }),
    ]));
    const rebuilt = await request(`/hr/special-workdays/rules/${firstBody.id}/versions`, "POST", { name: "薪資用過的版本", validFrom: "2026-04-01", wageKind: "fixed_hourly", fixedAmountMinor: 45000, allowances: [], overtimeRules: [] });
    expect(rebuilt.status, await rebuilt.clone().text()).toBe(201);
    expect(await rebuilt.json()).toMatchObject({ versionNumber: 3 });
  });

  it("套用改到別的規則後，薪資快照記過的版本與原規則仍然保留", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    const first = await request("/hr/special-workdays/rules", "POST", { name: "被改走的規則", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, allowances: [], overtimeRules: [] });
    const firstBody = await first.json() as { id: string; versionId: string };
    const second = await request(`/hr/special-workdays/rules/${firstBody.id}/versions`, "POST", { name: "被改走的規則", validFrom: "2026-04-01", wageKind: "fixed_hourly", fixedAmountMinor: 35000, allowances: [], overtimeRules: [] });
    const secondBody = await second.json() as { versionId: string };
    const other = await request("/hr/special-workdays/rules", "POST", { name: "改過去的規則", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 20000, allowances: [], overtimeRules: [] });
    const otherBody = await other.json() as { id: string };
    expect((await request("/hr/special-workdays/assignments", "POST", { ruleId: firstBody.id, assignments: [{ employmentId, workDate: "2026-04-03", allowanceQuantities: [] }] })).status).toBe(201);
    const listedAssignments = await (await request("/hr/special-workdays/assignments")).json() as { assignments: Array<{ assignment: { id: string; ruleId: string } }> };
    const assignmentId = listedAssignments.assignments.find((item) => item.assignment.ruleId === firstBody.id)!.assignment.id;
    const db = createDatabase(d1 as never);
    await db.insert(hrPayrollPeriods).values({ id: "payroll-period-moved", periodKey: "2026-04", attendanceStart: "2026-04-01", attendanceEnd: "2026-05-01", createdBy: "admin" });
    await db.insert(hrPayrollRuns).values({ id: "payroll-run-moved", payrollPeriodId: "payroll-period-moved", versionNumber: 1, requestId: "payroll-request-moved", inputRevision: 1, sourceSnapshotJson: JSON.stringify({ specialWorkdays: [{ id: assignmentId, ruleId: firstBody.id, ruleVersionId: secondBody.versionId }] }), engineVersion: "test", status: "ready", expectedCount: 0, completedCount: 0, createdBy: "admin" });

    const moved = await request(`/hr/special-workdays/assignments/${assignmentId}`, "PATCH", { ruleId: otherBody.id, employmentId, workDate: "2026-04-03", allowanceQuantities: [] });
    expect(moved.status, await moved.clone().text()).toBe(200);
    const voided = await request(`/hr/special-workdays/rules/${firstBody.id}/versions/${secondBody.versionId}/void`, "POST", {});
    expect(voided.status, await voided.clone().text()).toBe(200);
    const listed = await (await request("/hr/special-workdays/rules")).json() as { rules: Array<{ rule: { id: string; revision: number }; payrollReferenced: boolean; versions: Array<{ id: string; voidedAt: string | null }> }> };
    const rule = listed.rules.find((item) => item.rule.id === firstBody.id)!;
    expect(rule.versions).toEqual(expect.arrayContaining([expect.objectContaining({ id: secondBody.versionId, voidedAt: expect.any(String) })]));
    expect(rule.payrollReferenced).toBe(true);
    const deletedRule = await request(`/hr/special-workdays/rules/${firstBody.id}`, "DELETE", { revision: rule.rule.revision });
    expect(deletedRule.status, await deletedRule.clone().text()).toBe(409);
  });

  it("沒記版本 ID 的舊薪資快照，依快照當時的規則與日期保護版本與規則", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    const first = await request("/hr/special-workdays/rules", "POST", { name: "舊快照的規則", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, allowances: [], overtimeRules: [] });
    const firstBody = await first.json() as { id: string; versionId: string };
    const second = await request(`/hr/special-workdays/rules/${firstBody.id}/versions`, "POST", { name: "舊快照的規則", validFrom: "2026-04-01", wageKind: "fixed_hourly", fixedAmountMinor: 35000, allowances: [], overtimeRules: [] });
    const secondBody = await second.json() as { versionId: string };
    const other = await request("/hr/special-workdays/rules", "POST", { name: "舊快照改過去的規則", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 20000, allowances: [], overtimeRules: [] });
    const otherBody = await other.json() as { id: string };
    expect((await request("/hr/special-workdays/assignments", "POST", { ruleId: firstBody.id, assignments: [{ employmentId, workDate: "2026-04-03", allowanceQuantities: [] }] })).status).toBe(201);
    const listedAssignments = await (await request("/hr/special-workdays/assignments")).json() as { assignments: Array<{ assignment: { id: string; ruleId: string } }> };
    const assignmentId = listedAssignments.assignments.find((item) => item.assignment.ruleId === firstBody.id)!.assignment.id;
    const db = createDatabase(d1 as never);
    await db.insert(hrPayrollPeriods).values({ id: "payroll-period-legacy", periodKey: "2026-04", attendanceStart: "2026-04-01", attendanceEnd: "2026-05-01", createdBy: "admin" });
    await db.insert(hrPayrollRuns).values({ id: "payroll-run-legacy", payrollPeriodId: "payroll-period-legacy", versionNumber: 1, requestId: "payroll-request-legacy", inputRevision: 1, sourceSnapshotJson: JSON.stringify({ specialWorkdays: [{ id: assignmentId, ruleId: firstBody.id, workDate: "2026-04-03" }] }), engineVersion: "test", status: "ready", expectedCount: 0, completedCount: 0, createdBy: "admin" });
    expect((await request(`/hr/special-workdays/assignments/${assignmentId}`, "PATCH", { ruleId: otherBody.id, employmentId, workDate: "2026-04-20", allowanceQuantities: [] })).status).toBe(200);

    expect((await request(`/hr/special-workdays/rules/${firstBody.id}/versions/${secondBody.versionId}/void`, "POST", {})).status).toBe(200);
    const listed = await (await request("/hr/special-workdays/rules")).json() as { rules: Array<{ rule: { id: string; revision: number }; payrollReferenced: boolean; versions: Array<{ id: string; voidedAt: string | null }> }> };
    const rule = listed.rules.find((item) => item.rule.id === firstBody.id)!;
    expect(rule.versions).toEqual(expect.arrayContaining([expect.objectContaining({ id: secondBody.versionId, voidedAt: expect.any(String) })]));
    expect(rule.payrollReferenced).toBe(true);
    expect((await request(`/hr/special-workdays/rules/${firstBody.id}`, "DELETE", { revision: rule.rule.revision })).status).toBe(409);
    // 那筆進過薪資的套用現在掛在改過去的規則底下，所以那條規則也不能刪。
    expect(listed.rules.find((item) => item.rule.id === otherBody.id)!.payrollReferenced).toBe(true);
  });

  it("建立新版本時才清掉先前留下的已解除版本，被拒絕的請求不會動到資料", async () => {
    const first = await request("/hr/special-workdays/rules", "POST", { name: "留有舊解除版本", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, allowances: [], overtimeRules: [] });
    const firstBody = await first.json() as { id: string; versionId: string };
    const second = await request(`/hr/special-workdays/rules/${firstBody.id}/versions`, "POST", { name: "留有舊解除版本", validFrom: "2026-02-01", wageKind: "fixed_hourly", fixedAmountMinor: 35000, allowances: [{ itemName: "餐費", unitAmountMinor: 10000 }], overtimeRules: [] });
    const secondBody = await second.json() as { versionId: string };
    const db = createDatabase(d1 as never);
    // 模擬「解除只標記、不刪除」時期留下的資料。
    await db.update(hrSpecialWorkdayRuleVersions).set({ validTo: null, supersededValidTo: null, supersededByVersionId: null }).where(eq(hrSpecialWorkdayRuleVersions.id, firstBody.versionId));
    await db.update(hrSpecialWorkdayRuleVersions).set({ voidedAt: "2026-02-02 00:00:00", voidedBy: "admin" }).where(eq(hrSpecialWorkdayRuleVersions.id, secondBody.versionId));
    const versionIds = async () => (await db.select({ id: hrSpecialWorkdayRuleVersions.id }).from(hrSpecialWorkdayRuleVersions).where(eq(hrSpecialWorkdayRuleVersions.ruleId, firstBody.id))).map((row) => row.id);

    const rejected = await request(`/hr/special-workdays/rules/${firstBody.id}/versions`, "POST", { name: "留有舊解除版本", validFrom: "2025-12-01", wageKind: "fixed_hourly", fixedAmountMinor: 45000, allowances: [], overtimeRules: [] });
    expect(rejected.status, await rejected.clone().text()).toBe(400);
    expect(await versionIds()).toContain(secondBody.versionId);

    const rebuilt = await request(`/hr/special-workdays/rules/${firstBody.id}/versions`, "POST", { name: "留有舊解除版本", validFrom: "2026-02-01", wageKind: "fixed_hourly", fixedAmountMinor: 45000, allowances: [], overtimeRules: [] });
    expect(rebuilt.status, await rebuilt.clone().text()).toBe(201);
    expect(await rebuilt.json()).toMatchObject({ versionNumber: 2 });
    expect(await versionIds()).not.toContain(secondBody.versionId);
    const [createdEvent] = await db.select({ payloadJson: activityEvents.payloadJson }).from(activityEvents).where(eq(activityEvents.eventType, "special_workday_rule_version_created")).orderBy(desc(activityEvents.createdAt)).limit(1);
    expect(JSON.parse(createdEvent!.payloadJson)).toMatchObject({ removedVoidedVersions: [{ versionId: secondBody.versionId, fixedAmountMinor: 35000, allowances: [{ itemName: "餐費", unitAmountMinor: 10000 }] }] });
  });

  it("未納入薪資試算的特殊上班日規則與套用可以刪除", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    const unused = await request("/hr/special-workdays/rules", "POST", { name: "未套用可刪除", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, allowances: [{ itemName: "餐費", unitAmountMinor: 10000 }], overtimeRules: [] });
    expect(unused.status, await unused.clone().text()).toBe(201);
    const unusedBody = await unused.json() as { id: string };
    const unusedVersion = await request(`/hr/special-workdays/rules/${unusedBody.id}/versions`, "POST", { name: "未套用可刪除", validFrom: "2026-02-01", wageKind: "fixed_hourly", fixedAmountMinor: 30000, allowances: [], overtimeRules: [] });
    expect(unusedVersion.status, await unusedVersion.clone().text()).toBe(201);
    /*
     * 拿過期的 revision 刪不動：中途有人加版本時，整條規則不該被連同對方那一版一起刪掉。
     *
     * 要斷言到**版本層**，不能只看規則列還在。刪除的語句順序是「先刪版本／補貼／加班級距，
     * 最後那句才比對 revision」，所以只驗父列的話，整批 rollback 與「子列被刪光但父列留著」
     * 兩種結果長得一模一樣——那正是 CLAUDE.md 為 0023 記下的那種假信心。
     */
    const stale = await request(`/hr/special-workdays/rules/${unusedBody.id}`, "DELETE", { revision: 999 });
    expect(stale.status, await stale.clone().text()).toBe(409);
    const survived = await (await request("/hr/special-workdays/rules")).json() as { rules: Array<{ rule: { id: string; revision: number }; versions: Array<{ allowances: unknown[]; overtimeRules: unknown[] }> }> };
    const current = survived.rules.find((item) => item.rule.id === unusedBody.id);
    expect(current).toBeDefined();
    expect(current!.versions).toHaveLength(2);
    expect(current!.versions.flatMap((version) => version.allowances)).toHaveLength(1);

    const deleted = await request(`/hr/special-workdays/rules/${unusedBody.id}`, "DELETE", { revision: current!.rule.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await deleted.json()).toMatchObject({ id: unusedBody.id, deleted: true });
    const afterDelete = await (await request("/hr/special-workdays/rules")).json() as { rules: Array<{ rule: { id: string } }> };
    expect(afterDelete.rules.some((item) => item.rule.id === unusedBody.id)).toBe(false);
    const db = createDatabase(d1 as never);
    const [deleteEvent] = await db.select({ entityLabel: activityEvents.entityLabel, summary: activityEvents.summary, payloadJson: activityEvents.payloadJson })
      .from(activityEvents).where(eq(activityEvents.eventType, "special_workday_rule_deleted")).orderBy(desc(activityEvents.createdAt)).limit(1);
    expect(deleteEvent).toMatchObject({ entityLabel: "未套用可刪除", summary: "特殊上班日規則刪除" });
    expect(JSON.parse(deleteEvent!.payloadJson)).toMatchObject({ ruleName: "未套用可刪除", removedVersions: [expect.objectContaining({ versionNumber: 2 }), expect.objectContaining({ versionNumber: 1, allowances: [{ itemName: "餐費", unitAmountMinor: 10000 }] })], removedAssignmentCount: 0, removedAssignments: [] });

    const used = await request("/hr/special-workdays/rules", "POST", { name: "已有套用不可刪除", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, allowances: [], overtimeRules: [] });
    expect(used.status, await used.clone().text()).toBe(201);
    const usedBody = await used.json() as { id: string; versionId: string };
    const assigned = await request("/hr/special-workdays/assignments", "POST", { ruleId: usedBody.id, assignments: [{ employmentId, workDate: "2026-01-15", allowanceQuantity: 0 }] });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    // 開著頁面的人手上還是套用之前的 revision：別人剛加的套用不能被這次刪除一起帶走。
    const beforeAssign = await request(`/hr/special-workdays/rules/${usedBody.id}`, "DELETE", { revision: 1 });
    expect(beforeAssign.status, await beforeAssign.clone().text()).toBe(409);
    const stillAssigned = await (await request("/hr/special-workdays/assignments")).json() as { assignments: Array<{ assignment: { ruleId: string } }> };
    expect(stillAssigned.assignments.some((item) => item.assignment.ruleId === usedBody.id)).toBe(true);
    const refreshed = await (await request("/hr/special-workdays/rules")).json() as { rules: Array<{ rule: { id: string; revision: number }; payrollReferenced: boolean }> };
    const usedRule = refreshed.rules.find((item) => item.rule.id === usedBody.id)!;
    expect(usedRule.payrollReferenced).toBe(false);
    const deletedUsed = await request(`/hr/special-workdays/rules/${usedBody.id}`, "DELETE", { revision: usedRule.rule.revision });
    expect(deletedUsed.status, await deletedUsed.clone().text()).toBe(200);
    const [usedDeleteEvent] = await db.select({ payloadJson: activityEvents.payloadJson }).from(activityEvents).where(eq(activityEvents.eventType, "special_workday_rule_deleted")).orderBy(desc(activityEvents.createdAt)).limit(1);
    expect(JSON.parse(usedDeleteEvent!.payloadJson)).toMatchObject({ ruleName: "已有套用不可刪除", removedAssignmentCount: 1, removedAssignments: [{ employmentId, workerId: null, workDate: "2026-01-15" }] });
    const afterUsedDelete = await (await request("/hr/special-workdays/rules")).json() as { rules: Array<{ rule: { id: string } }> };
    expect(afterUsedDelete.rules.some((item) => item.rule.id === usedBody.id)).toBe(false);
    const afterAssignmentDelete = await (await request("/hr/special-workdays/assignments")).json() as { assignments: Array<{ assignment: { ruleId: string } }> };
    expect(afterAssignmentDelete.assignments.some((item) => item.assignment.ruleId === usedBody.id)).toBe(false);
  });

  it("尚未納入薪資試算的特殊上班日套用可以單筆刪除", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const created = await request("/hr/special-workdays/rules", "POST", { name: "可刪除特殊日套用", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, allowances: [], overtimeRules: [] });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id: ruleId } = await created.json() as { id: string };
    const assigned = await request("/hr/special-workdays/assignments", "POST", { ruleId, assignments: [{ employmentId: profile.employments[0]!.id, workDate: "2026-04-01", allowanceQuantities: [] }] });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    const listed = await (await request("/hr/special-workdays/assignments")).json() as { assignments: Array<{ assignment: { id: string; ruleId: string }; includedInPayroll: boolean }> };
    const assignment = listed.assignments.find((item) => item.assignment.ruleId === ruleId)!;
    expect(assignment.includedInPayroll).toBe(false);

    // 索引表對批次沒有外鍵；批次已經不在的列（舊版 Worker 刪批次時留下的）不能把套用鎖住。
    d1.sqlite.prepare("INSERT INTO hr_payroll_special_workday_sources(id,payroll_run_id,assignment_id) VALUES ('orphan','run-that-no-longer-exists',?)").run(assignment.assignment.id);
    const withOrphan = await (await request("/hr/special-workdays/assignments")).json() as { assignments: Array<{ assignment: { id: string }; includedInPayroll: boolean }> };
    expect(withOrphan.assignments.find((item) => item.assignment.id === assignment.assignment.id)?.includedInPayroll).toBe(false);
    const shown = { ruleId, employmentId: profile.employments[0]!.id, workerId: null, workDate: "2026-04-01" };
    // 確認框上的內容跟資料庫對不上（別人剛改過日期）時不能刪。
    const stale = await request(`/hr/special-workdays/assignments/${assignment.assignment.id}`, "DELETE", { ...shown, workDate: "2026-04-09" });
    expect(stale.status, await stale.clone().text()).toBe(409);
    const deleted = await request(`/hr/special-workdays/assignments/${assignment.assignment.id}`, "DELETE", shown);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const afterDelete = await (await request("/hr/special-workdays/assignments")).json() as { assignments: Array<{ assignment: { id: string } }> };
    expect(afterDelete.assignments.some((item) => item.assignment.id === assignment.assignment.id)).toBe(false);
    const db = createDatabase(d1 as never);
    const [event] = await db.select({ summary: activityEvents.summary, payloadJson: activityEvents.payloadJson }).from(activityEvents).where(eq(activityEvents.eventType, "special_workday_assignment_deleted")).orderBy(desc(activityEvents.createdAt)).limit(1);
    expect(event).toMatchObject({ summary: "特殊上班日套用刪除", payloadJson: expect.stringContaining("2026-04-01") });
  });

  it("已納入薪資試算版本的特殊上班日套用與規則不能刪除", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const created = await request("/hr/special-workdays/rules", "POST", { name: "薪資版本保留特殊日", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, allowances: [], overtimeRules: [] });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id: ruleId } = await created.json() as { id: string };
    const assigned = await request("/hr/special-workdays/assignments", "POST", { ruleId, assignments: [{ employmentId: profile.employments[0]!.id, workDate: "2026-04-02", allowanceQuantities: [] }] });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    const listed = await (await request("/hr/special-workdays/assignments")).json() as { assignments: Array<{ assignment: { id: string; ruleId: string } }> };
    const assignmentId = listed.assignments.find((item) => item.assignment.ruleId === ruleId)!.assignment.id;
    const db = createDatabase(d1 as never);
    await db.insert(hrPayrollPeriods).values({ id: "payroll-period-2026-04", periodKey: "2026-04", attendanceStart: "2026-04-01", attendanceEnd: "2026-05-01", createdBy: "admin" });
    await db.insert(hrPayrollRuns).values({ id: "payroll-run-special-reference", payrollPeriodId: "payroll-period-2026-04", versionNumber: 1, requestId: "payroll-request-special-reference", inputRevision: 1, sourceSnapshotJson: JSON.stringify({ specialWorkdays: [{ id: assignmentId }] }), engineVersion: "test", status: "ready", expectedCount: 0, completedCount: 0, createdBy: "admin" });

    const protectedAssignment = await request(`/hr/special-workdays/assignments/${assignmentId}`, "DELETE", { ruleId, employmentId: profile.employments[0]!.id, workerId: null, workDate: "2026-04-02" });
    expect(protectedAssignment.status, await protectedAssignment.clone().text()).toBe(409);
    // 第一個碰到的請求就把沒有索引的批次補寫好，而且只補一次。
    const indexed = () => d1.sqlite.prepare("SELECT payroll_run_id, assignment_id FROM hr_payroll_special_workday_sources").all();
    expect(indexed()).toEqual([{ payroll_run_id: "payroll-run-special-reference", assignment_id: assignmentId }]);
    expect(d1.sqlite.prepare("SELECT payroll_run_id FROM hr_payroll_special_workday_source_runs").all()).toEqual([{ payroll_run_id: "payroll-run-special-reference" }]);
    const listedProtected = await (await request("/hr/special-workdays/assignments")).json() as { assignments: Array<{ assignment: { id: string }; includedInPayroll: boolean }> };
    expect(listedProtected.assignments.find((item) => item.assignment.id === assignmentId)?.includedInPayroll).toBe(true);
    expect(indexed()).toHaveLength(1);
    const protectedRule = await request(`/hr/special-workdays/rules/${ruleId}`, "DELETE", { revision: 1 });
    expect(protectedRule.status, await protectedRule.clone().text()).toBe(409);
  });

  it("公司負擔規則會進入薪資扣款，薪資加扣項可直接指定生效月份", async () => {
    const systemRules = await request("/hr/insurance-contribution-rules");
    expect(systemRules.status, await systemRules.clone().text()).toBe(200);
    expect(await systemRules.json()).toMatchObject({ rules: expect.arrayContaining([
      expect.objectContaining({ id: "system-insurance-contribution-labor-ordinary-accident-2026", scheme: "labor", component: "ordinary_accident", totalRatePpm: 115_000, employeeRatePpm: 23_000, isSystemDefault: true }),
      expect.objectContaining({ id: "system-insurance-contribution-labor-employment-2026", scheme: "labor", component: "employment", totalRatePpm: 10_000, employeeRatePpm: 2_000, isSystemDefault: true }),
      expect.objectContaining({ id: "system-insurance-contribution-health-2026", scheme: "health", component: null, employeeRatePpm: 15_510, dependentRatePpm: 1_000_000, isSystemDefault: true }),
    ]) });
    const defaultLaborEstimate = await request("/hr/employments/dev-employment-lin/insurance/estimate", "POST", { validFrom: "2026-01-01", versions: [{ scheme: "labor", status: "enrolled", insuredAmountMinor: 4_010_000, dependentCount: 0 }] });
    expect(defaultLaborEstimate.status, await defaultLaborEstimate.clone().text()).toBe(200);
    expect(await defaultLaborEstimate.json()).toMatchObject({ estimates: [expect.objectContaining({ scheme: "labor", employeeAmountMinor: 100_200, employeeRatePpm: 25_000, components: [
      expect.objectContaining({ component: "ordinary_accident", employeeAmountMinor: 92_200 }),
      expect.objectContaining({ component: "employment", employeeAmountMinor: 8_000 }),
    ] })] });
    expect((await request("/hr/insurance-contribution-rules", "POST", { scheme: "labor", component: "ordinary_accident", validFrom: "2027-01-01", employeeRatePpm: 23000, employerRatePpm: 80500, dependentRatePpm: 0, sourceKind: "manual", note: "測試普通事故分項規則" })).status).toBe(201);
    expect((await request("/hr/insurance-contribution-rules", "POST", { scheme: "labor", component: "employment", validFrom: "2027-01-01", employeeRatePpm: 2000, employerRatePpm: 7000, dependentRatePpm: 0, sourceKind: "manual", note: "測試就業保險分項規則" })).status).toBe(201);
    const componentEstimate = await request("/hr/employments/dev-employment-lin/insurance/estimate", "POST", { validFrom: "2027-01-01", versions: [{ scheme: "labor", status: "enrolled", insuredAmountMinor: 4_010_000, dependentCount: 0 }] });
    expect(componentEstimate.status, await componentEstimate.clone().text()).toBe(200);
    expect(await componentEstimate.json()).toMatchObject({ estimates: [expect.objectContaining({ employeeAmountMinor: 100_200, components: expect.arrayContaining([
      expect.objectContaining({ component: "ordinary_accident", employeeAmountMinor: 92_200 }),
      expect.objectContaining({ component: "employment", employeeAmountMinor: 8_000 }),
    ]) })] });
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    expect((await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2026-01-01", payBasis: "monthly", baseAmountMinor: 4000000 })).status).toBe(201);
    const defaultEstimate = await request(`/hr/employments/${employmentId}/insurance/estimate`, "POST", { validFrom: "2026-01-01", versions: [{ scheme: "health", status: "enrolled", insuredAmountMinor: 4_200_000, dependentCount: 1 }] });
    expect(defaultEstimate.status, await defaultEstimate.clone().text()).toBe(200);
    expect(await defaultEstimate.json()).toMatchObject({ estimates: [expect.objectContaining({ scheme: "health", employeeAmountMinor: 130_200 })] });
    expect((await request("/hr/insurance-contribution-rules", "POST", { scheme: "labor", validFrom: "2026-01-01", employeeRatePpm: 10000, employerRatePpm: 20000, dependentRatePpm: 1000000, sourceKind: "manual", note: "測試公司規則" })).status).toBe(201);
    expect((await request("/hr/insurance-contribution-rules", "POST", { scheme: "health", validFrom: "2026-01-01", employeeRatePpm: 50000, employerRatePpm: 100000, dependentRatePpm: 100000, sourceKind: "manual", note: "測試健保規則" })).status).toBe(201);
    const estimate = await request(`/hr/employments/${employmentId}/insurance/estimate`, "POST", { validFrom: "2026-01-01", versions: [
      { scheme: "labor", status: "enrolled", insuredAmountMinor: 3000000, dependentCount: 0 },
      { scheme: "health", status: "enrolled", insuredAmountMinor: 3000000, dependentCount: 1 },
    ] });
    expect(estimate.status, await estimate.clone().text()).toBe(200);
    expect(await estimate.json()).toMatchObject({ estimates: expect.arrayContaining([
      expect.objectContaining({ scheme: "labor", employeeAmountMinor: 30000, employeeRatePpm: 10000 }),
      expect.objectContaining({ scheme: "health", employeeAmountMinor: 165000, employeeRatePpm: 50000, dependentRatePpm: 100000 }),
    ]) });
    expect((await request(`/hr/employments/${employmentId}/insurance`, "POST", { versions: [{ scheme: "labor", status: "enrolled", validFrom: "2026-01-01", insuredAmountMinor: 3000000, dependentCount: 0, rateYear: 2026, sourceKind: "manual", note: "測試投保" }] })).status).toBe(201);
    const calculated = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-01", employeeUserIds: ["employee"], requestId: "close-test-2026-01" });
    expect(calculated.status, await calculated.clone().text()).toBe(200);
    const result = await calculated.json() as { run: { runId: string; warnings: string[]; employees: Array<{ lines: Array<{ lineKey: string; amountMinor: number }> }> } };
    expect(result.run.warnings).not.toContain("本版未計算勞健保扣款：員工尚未建立有效的加保版本。");
    expect(result.run.employees[0]?.lines).toEqual(expect.arrayContaining([expect.objectContaining({ lineKey: "labor_insurance", amountMinor: 30000 })]));
    const closed = await request(`/hr/payroll/runs/${result.run.runId}/close`, "POST", {});
    expect(closed.status, await closed.clone().text()).toBe(200);
    expect((await request("/hr/payroll/calculate", "POST", { periodKey: "2026-01", employeeUserIds: ["employee"], requestId: "close-test-2026-01-repeat" })).status).toBe(409);
    const zeroAdjustment = await request("/hr/payroll/adjustments", "POST", { employmentId, effectivePeriodKey: "2026-02", reason: "零元項目", items: [{ itemName: "不應建立", amountMinor: 0 }] });
    expect(zeroAdjustment.status, await zeroAdjustment.clone().text()).toBe(400);
    const adjustment = await request("/hr/payroll/adjustments", "POST", { employmentId, effectivePeriodKey: "2026-02", reason: "一次性獎金", items: [{ itemName: "獎金", amountMinor: 100000 }] });
    expect(adjustment.status, await adjustment.clone().text()).toBe(201);
    const nextCalculation = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-02", employeeUserIds: ["employee"], requestId: "one-off-bonus-2026-02" });
    expect(nextCalculation.status, await nextCalculation.clone().text()).toBe(200);
    const nextResult = await nextCalculation.json() as { run: { employees: Array<{ lines: Array<{ lineKey: string; amountMinor: number }> }> } };
    expect(nextResult.run.employees[0]?.lines).toEqual(expect.arrayContaining([expect.objectContaining({ lineKey: "adjustment_1", amountMinor: 100000 })]));
  });
});
