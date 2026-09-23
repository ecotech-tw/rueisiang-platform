import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { desc, eq } from "drizzle-orm";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { activityEvents, hrInsuranceVersions, userRoleAssignments, users } from "@rueisiang/db/schema";
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
async function assign(serviceStartOn = "2026-01-01") {
  const response = await request("/hr/employees", "POST", { userId: "employee", employeeNumber: "E-PAY", position: "一般職員", serviceStartOn });
  expect(response.status, await response.clone().text()).toBe(201);
}
async function assignUser(userId: string, employeeNumber: string, serviceStartOn = "2026-01-01") {
  const response = await request("/hr/employees", "POST", { userId, employeeNumber, position: "一般職員", serviceStartOn });
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
    expect(draft.brackets).toEqual(brackets);

    const updated = await request(`/hr/insurance-rates/${createdBody.id}`, "PATCH", {
      sourceUrl: "勞保 2026 公告（修訂）", note: "人工覆核：已確認修訂版", contentHash: draft.contentHash,
      brackets: [brackets[0], { ...brackets[1], insuredAmount: 30400 }],
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const afterUpdate = await (await request("/hr/insurance-rates?year=2026")).json() as { tables: Array<{ id: string; contentHash: string; brackets: { insuredAmount: number }[] }> };
    const updatedDraft = afterUpdate.tables.find((table) => table.id === createdBody.id)!;
    expect(updatedDraft.brackets[1]?.insuredAmount).toBe(30400);
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

  it("特殊上班日保存規則版本快照，允許零補貼且阻擋重複套用", async () => {
    await assign();
    const profile = await (await request("/hr/employees/employee")).json() as { employments: { id: string }[] };
    const employmentId = profile.employments[0]!.id;
    const invalid = await request("/hr/special-workdays/rules", "POST", { name: "不連續特殊日", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, overtimeRules: [{ fromHalfHours: 2, toHalfHours: null, rateKind: "multiplier", multiplierPpm: 1_500_000 }], allowances: [] });
    expect(invalid.status, await invalid.clone().text()).toBe(400);
    const created = await request("/hr/special-workdays/rules", "POST", { name: "測試國定日", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, overtimeRules: [{ fromHalfHours: 1, toHalfHours: 4, rateKind: "multiplier", multiplierPpm: 1_500_000 }, { fromHalfHours: 5, toHalfHours: null, rateKind: "fixed_hourly", fixedAmountMinor: 35000 }], allowances: [{ itemName: "餐費", unitAmountMinor: 0 }, { itemName: "交通補貼", unitAmountMinor: 12000 }] });
    expect(created.status, await created.clone().text()).toBe(201);
    const createdBody = await created.json() as { versionId: string };
    const listed = await (await request("/hr/special-workdays/rules")).json() as { rules: Array<{ rule: { name: string }; versions: Array<{ id: string; workSource: string; note: string; allowances: Array<{ itemName: string; unitAmountMinor: number }>; overtimeRules: Array<{ fromHalfHours: number; toHalfHours: number | null; rateKind: string; fixedAmountMinor: number | null; multiplierPpm: number | null }> }> }> };
    expect(listed.rules).toEqual(expect.arrayContaining([expect.objectContaining({ rule: expect.objectContaining({ name: "測試國定日" }), versions: [expect.objectContaining({ id: createdBody.versionId, workSource: "hourly", note: "", overtimeRules: [expect.objectContaining({ fromHalfHours: 1, toHalfHours: 4, rateKind: "multiplier", multiplierPpm: 1_500_000 }), expect.objectContaining({ fromHalfHours: 5, toHalfHours: null, rateKind: "fixed_hourly", fixedAmountMinor: 35000 })], allowances: [expect.objectContaining({ itemName: "餐費", unitAmountMinor: 0 }), expect.objectContaining({ itemName: "交通補貼", unitAmountMinor: 12000 })] })] })]));
    const assigned = await request("/hr/special-workdays/assignments", "POST", { ruleVersionId: createdBody.versionId, assignments: [{ employmentId, workDate: "2026-02-28", allowanceQuantity: 0 }] });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    expect((await request("/hr/special-workdays/assignments?start=2026-02-01&end=2026-03-01")).status).toBe(200);
    expect((await request("/hr/special-workdays/assignments", "POST", { ruleVersionId: createdBody.versionId, assignments: [{ employmentId, workDate: "2026-02-28", allowanceQuantity: 0 }] })).status).toBe(409);
  });

  it("特殊上班日最新版本可解除並回到上一版，已套用日期保留快照", async () => {
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
    expect((await request("/hr/special-workdays/assignments", "POST", { ruleVersionId: secondBody.versionId, assignments: [{ employmentId, workDate: "2026-02-20", allowanceQuantity: 0 }] })).status).toBe(201);

    expect((await request(`/hr/special-workdays/rules/${firstBody.id}/versions/${firstBody.versionId}/void`, "POST", {})).status).toBe(409);
    const voided = await request(`/hr/special-workdays/rules/${firstBody.id}/versions/${secondBody.versionId}/void`, "POST", {});
    expect(voided.status, await voided.clone().text()).toBe(200);
    expect(await voided.json()).toMatchObject({ ruleId: firstBody.id, versionId: secondBody.versionId, previousVersionId: firstBody.versionId, status: "voided" });

    const listed = await (await request("/hr/special-workdays/rules")).json() as { rules: Array<{ rule: { id: string }; versions: Array<{ id: string; versionNumber: number; validTo: string | null; voidedAt: string | null; voidedBy: string | null }> }> };
    const versions = listed.rules.find((item) => item.rule.id === firstBody.id)!.versions;
    expect(versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstBody.versionId, versionNumber: 1, validTo: null, voidedAt: null }),
      expect.objectContaining({ id: secondBody.versionId, versionNumber: 2, voidedAt: expect.any(String), voidedBy: "admin" }),
    ]));
    expect((await request(`/hr/special-workdays/rules/${firstBody.id}/versions/${firstBody.versionId}/void`, "POST", {})).status).toBe(409);
    expect((await request("/hr/special-workdays/assignments", "POST", { ruleVersionId: secondBody.versionId, assignments: [{ employmentId, workDate: "2026-02-21", allowanceQuantity: 0 }] })).status).toBe(404);
    const assignmentRows = await (await request("/hr/special-workdays/assignments?start=2026-02-01&end=2026-03-01")).json() as { assignments: Array<{ assignment: { ruleVersionId: string }; ruleVersionVoidedAt: string | null }> };
    expect(assignmentRows.assignments).toEqual(expect.arrayContaining([expect.objectContaining({ assignment: expect.objectContaining({ ruleVersionId: secondBody.versionId }), ruleVersionVoidedAt: expect.any(String) })]));

    const rebuilt = await request(`/hr/special-workdays/rules/${firstBody.id}/versions`, "POST", { name: "可解除特殊日", validFrom: "2026-02-01", wageKind: "fixed_hourly", fixedAmountMinor: 45000, allowances: [], overtimeRules: [] });
    expect(rebuilt.status, await rebuilt.clone().text()).toBe(201);
    expect(await rebuilt.json()).toMatchObject({ versionNumber: 3 });
  });

  it("未套用的特殊上班日規則可以刪除，已有套用紀錄的規則只能停用", async () => {
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
    expect(deleteEvent).toMatchObject({ entityLabel: "未套用可刪除", summary: "特殊上班日規則刪除", payloadJson: JSON.stringify({ ruleName: "未套用可刪除" }) });

    const used = await request("/hr/special-workdays/rules", "POST", { name: "已有套用不可刪除", validFrom: "2026-01-01", wageKind: "fixed_hourly", fixedAmountMinor: 25000, allowances: [], overtimeRules: [] });
    expect(used.status, await used.clone().text()).toBe(201);
    const usedBody = await used.json() as { id: string; versionId: string };
    const assigned = await request("/hr/special-workdays/assignments", "POST", { ruleVersionId: usedBody.versionId, assignments: [{ employmentId, workDate: "2026-01-15", allowanceQuantity: 0 }] });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    const rejected = await request(`/hr/special-workdays/rules/${usedBody.id}`, "DELETE", { revision: 1 });
    expect(rejected.status, await rejected.clone().text()).toBe(409);
    const stillListed = await (await request("/hr/special-workdays/rules")).json() as { rules: Array<{ rule: { id: string; active: number } }> };
    expect(stillListed.rules).toEqual(expect.arrayContaining([expect.objectContaining({ rule: expect.objectContaining({ id: usedBody.id, active: 1 }) })]));
  });

  it("公司負擔規則會進入薪資扣款，結帳後同員工月份改用薪資調整", async () => {
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
    const adjustment = await request("/hr/payroll/adjustments", "POST", { employmentId, sourcePeriodKey: "2026-01", effectivePeriodKey: "2026-02", reason: "結帳後補發", items: [{ itemName: "補發", amountMinor: 50000 }] });
    expect(adjustment.status, await adjustment.clone().text()).toBe(201);
  });
});
