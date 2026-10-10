import {
  createDatabase, ensureAssistantDefaults, ensureAssistantLineChannel, getHrSelfToolAnnualLeave,
  linkLineAccount, listHrSelfToolLeaveRequests, replaceLineAccount, setAssistantChannelTools,
  setAssistantToolStatus, unlinkLineAccount, upsertAssistantLineGroup,
} from "@rueisiang/db";
import {
  assistantLineChannels, assistantLineGroups, authLineAccountLinks, hrAnnualLeaveEntitlements,
  hrAnnualLeaveLedger, hrAnnualLeavePolicyVersions, hrCompensationVersions, hrEmployments,
  hrEmploymentServicePeriods, hrLeaveRequests, hrLeaveTypes, users,
} from "@rueisiang/db/schema";
import { HR_TOOL_DEFINITIONS, PLATFORM_TOOL_MAP, toolKeysForLineSource } from "@rueisiang/tools";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertHrLineDeliveryAuthorized, LineHrSelfService } from "./assistant-hr.js";
import type { Env } from "./env.js";
import type { PiLineAgentRunRequest } from "./pi-agent-contract.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const NOW = Date.parse("2026-03-02T00:00:00Z");
const ASSISTANT = "hr-test-assistant";
const LOGIN_CHANNEL = "line-login-channel";
const HR_KEYS = HR_TOOL_DEFINITIONS.map((tool) => tool.key);
let d1: LocalD1;
let env: Env;
let input: PiLineAgentRunRequest;
const db = () => createDatabase(d1 as never);

async function seedLeave(id: string, userId = "alice", values: Partial<typeof hrLeaveRequests.$inferInsert> = {}) {
  await db().insert(hrLeaveRequests).values({
    id, employmentId: `employment-${userId}`, leaveTypeId: "annual-type", leaveType: "特休",
    status: "pending", startsAt: "2026-03-02 01:00:00", endsAt: "2026-03-02 09:00:00",
    startsOn: "2026-03-02", endsOn: "2026-03-03", durationMinutes: 480,
    reason: `機密請假原因-${userId}`, createdBy: userId, createdAt: "2026-03-01 16:00:00", ...values,
  });
}

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  d1 = createLocalD1();
  await db().insert(users).values([
    { id: "alice", email: "alice@example.test", displayName: "甲員工", status: "active" },
    { id: "bob", email: "bob@example.test", displayName: "乙員工", status: "active" },
  ]);
  for (const userId of ["alice", "bob"]) {
    await db().insert(hrEmployments).values({ id: `employment-${userId}`, employeeUserId: userId, employeeNumber: userId, legalName: userId, position: "職員" });
    await db().insert(hrEmploymentServicePeriods).values({ employmentId: `employment-${userId}`, serviceStartOn: "2025-03-01" });
    await db().insert(hrCompensationVersions).values({ id: `salary-${userId}`, employmentId: `employment-${userId}`, versionNumber: 1, validFrom: "2025-03-01", payBasis: "monthly", baseAmountMinor: 3_000_000, createdBy: userId });
  }
  await db().insert(hrLeaveTypes).values({ id: "annual-type", name: "測試特休", leaveKind: "annual", createdBy: "alice" });
  await ensureAssistantDefaults(db(), { assistantKey: ASSISTANT, defaultModel: "gpt-5.4-mini", defaultPrompt: "測試", toolKeys: HR_KEYS });
  const channel = await ensureAssistantLineChannel(db(), { assistantKey: ASSISTANT, defaultToolKeys: HR_KEYS });
  await db().update(assistantLineChannels).set({ enabled: true }).where(eq(assistantLineChannels.channelKey, channel.channelKey));
  const conversation = await upsertAssistantLineGroup(db(), { channelKey: channel.channelKey, lineGroupId: "U-alice", sourceType: "user" });
  await db().update(assistantLineGroups).set({ enabled: true }).where(eq(assistantLineGroups.id, conversation.id));
  await linkLineAccount(db(), "alice", { channelId: LOGIN_CHANNEL, lineUserId: "U-alice" });
  await linkLineAccount(db(), "bob", { channelId: LOGIN_CHANNEL, lineUserId: "U-bob" });
  input = {
    assistantKey: ASSISTANT, channelKey: channel.channelKey, groupRowId: conversation.id,
    lineGroupId: "U-alice", sourceType: "user", contextGeneration: "", webhookEventId: "event", runId: "run",
    model: "gpt-5.4-mini", systemPrompt: "測試", userText: "查我自己的假", toolKeys: HR_KEYS,
  };
  env = { DB: d1, AUTH_SESSION_SECRET: "hr-test-secret", LINE_LIFF_CHANNEL_ID: LOGIN_CHANNEL } as never;
});

afterEach(() => { vi.restoreAllMocks(); d1.sqlite.close(); });

function service() { return new LineHrSelfService(db(), env, input); }

describe("小香 HR 本人授權", () => {
  it("必須先 authorize，工具回應與 schema 不含 token 或查詢對象", async () => {
    const hrSelf = service();
    await expect(hrSelf.leaveRequests({})).rejects.toThrow("先呼叫 hr_authorize");
    const toolContext = { surface: "line", lineSourceType: "user", services: { hrSelf } } as const;
    const authorized = await PLATFORM_TOOL_MAP.get("hr_authorize")!.execute({}, toolContext);
    expect(JSON.parse(authorized)).toMatchObject({ authorized: true });
    expect(authorized).not.toMatch(/token|alice|U-alice|linkVersion/);
    for (const tool of HR_TOOL_DEFINITIONS) expect(Object.keys(tool.parameters.properties)).not.toEqual(expect.arrayContaining(["userId", "employeeUserId", "lineUserId", "token"]));
    await expect(PLATFORM_TOOL_MAP.get("hr_get_my_leave_requests")!.execute({ employeeUserId: "bob" }, toolContext)).rejects.toThrow("不接受查詢對象");
    await expect(PLATFORM_TOOL_MAP.get("hr_authorize")!.execute({ token: "fake" }, toolContext)).rejects.toThrow("不接受");
  });

  it("只查綁定員工，即使同時存在其他員工的假單", async () => {
    await seedLeave("alice-pending"); await seedLeave("bob-secret", "bob");
    const hrSelf = service(); await hrSelf.authorize();
    const result = await hrSelf.leaveRequests({ status: "pending" });
    expect(result.requests.map((row) => row.id)).toEqual(["alice-pending"]);
    expect(JSON.stringify(result)).not.toMatch(/bob|機密請假原因|reviewComment|reviewedBy/);
  });

  it.each(["group", "room"] as const)("%s 不提供 HR 工具，也不查任何綁定或員工資料", async (sourceType) => {
    expect(toolKeysForLineSource(["hr_authorize", "hr_get_my_annual_leave", "crm_search_customers"], sourceType)).toEqual(["crm_search_customers"]);
    const database = db(); const select = vi.spyOn(database, "select");
    expect(() => new LineHrSelfService(database, env, { ...input, sourceType })).toThrow("僅限 LINE 本人私訊");
    await expect(assertHrLineDeliveryAuthorized(database, env, { ...input, sourceType }, { userId: "alice", linkVersion: "fake", runId: input.runId, expiresAt: NOW / 1000 + 300 }, HR_KEYS)).rejects.toThrow("僅限 LINE 本人私訊");
    expect(select).not.toHaveBeenCalled();
    await expect(PLATFORM_TOOL_MAP.get("hr_authorize")!.execute({}, { surface: "line", lineSourceType: sourceType })).rejects.toThrow("僅限 LINE 本人私訊");
  });

  it("使用既有小香 channel，不需要額外 HR channel key；LINE Login 未設定時仍 fail closed", async () => {
    const database = db();
    const select = vi.spyOn(database, "select");
    const hrSelf = new LineHrSelfService(database, env, input);
    await expect(hrSelf.authorize()).resolves.toMatchObject({ authorized: true });
    expect(() => new LineHrSelfService(database, { ...env, LINE_LIFF_CHANNEL_ID: undefined }, input)).toThrow("LINE HR 員工登入尚未設定");
    expect(select).toHaveBeenCalled();
  });

  it("不能把 Messaging channel ID 當成 LINE Login 的綁定 scope", async () => {
    const hrSelf = new LineHrSelfService(db(), { ...env, LINE_LIFF_CHANNEL_ID: input.channelKey }, input);
    await expect(hrSelf.authorize()).rejects.toThrow("完成帳號綁定");
  });

  it("未綁定時引導既有流程，不以姓名辨識", async () => {
    await unlinkLineAccount(db(), "alice");
    await expect(service().authorize()).rejects.toThrow("完成帳號綁定");
  });

  it.each(["停權", "離職", "解除綁定", "停用工具", "取消 channel 授權", "停用對話", "停用 channel", "重設對話"])("%s 在 token 有效期間立即阻擋查詢與回覆", async (change) => {
    const hrSelf = service(); await hrSelf.authorize(); const identity = hrSelf.authorization!;
    if (change === "停權") await db().update(users).set({ status: "disabled" }).where(eq(users.id, "alice"));
    if (change === "離職") await db().update(hrEmployments).set({ archivedAt: "2026-03-02" }).where(eq(hrEmployments.id, "employment-alice"));
    if (change === "解除綁定") await unlinkLineAccount(db(), "alice");
    if (change === "停用工具") await setAssistantToolStatus(db(), { key: "hr_authorize", status: "disabled", updatedBy: "alice" });
    if (change === "取消 channel 授權") await setAssistantChannelTools(db(), { channelKey: input.channelKey, toolKeys: [], updatedBy: "alice" });
    if (change === "停用對話") await db().update(assistantLineGroups).set({ enabled: false }).where(eq(assistantLineGroups.id, input.groupRowId));
    if (change === "停用 channel") await db().update(assistantLineChannels).set({ enabled: false }).where(eq(assistantLineChannels.channelKey, input.channelKey));
    if (change === "重設對話") await db().update(assistantLineGroups).set({ contextResetAt: "2026-03-02T00:00:00Z" }).where(eq(assistantLineGroups.id, input.groupRowId));
    await expect(hrSelf.leaveRequests({})).rejects.toThrow();
    await expect(assertHrLineDeliveryAuthorized(db(), env, input, identity, HR_KEYS)).rejects.toThrow();
  });

  it("同秒解除後重綁相同帳號，舊 token 也不得復活", async () => {
    const hrSelf = service(); await hrSelf.authorize(); const oldIdentity = hrSelf.authorization;
    await unlinkLineAccount(db(), "alice");
    await linkLineAccount(db(), "alice", { channelId: LOGIN_CHANNEL, lineUserId: "U-alice" });
    expect((await db().select().from(authLineAccountLinks).where(eq(authLineAccountLinks.userId, "alice")))[0]?.linkVersion).not.toBe(oldIdentity!.linkVersion);
    await expect(hrSelf.annualLeave()).rejects.toThrow("綁定已變更");
    await expect(hrSelf.authorize()).rejects.toThrow("綁定已變更");
  });

  it("換綁定、換員工後不能送出舊員工回答", async () => {
    const hrSelf = service(); await hrSelf.authorize();
    await replaceLineAccount(db(), "alice", { channelId: LOGIN_CHANNEL, lineUserId: "U-new-alice" });
    await replaceLineAccount(db(), "bob", { channelId: LOGIN_CHANNEL, lineUserId: "U-alice" });
    await expect(hrSelf.leaveRequests({})).rejects.toThrow("綁定已變更");
    await expect(assertHrLineDeliveryAuthorized(db(), env, input, hrSelf.authorization!, HR_KEYS)).rejects.toThrow("綁定已變更");
    const next = service(); await next.authorize(); expect(next.authorization?.userId).toBe("bob");
  });

  it("本輪 token 過期或新一輪必須再次 authorize", async () => {
    const hrSelf = service(); await hrSelf.authorize();
    const authorization = hrSelf.authorization!;
    await expect(assertHrLineDeliveryAuthorized(db(), env, { ...input, runId: "another-run" }, authorization, HR_KEYS)).rejects.toThrow("不屬於此回覆");
    vi.mocked(Date.now).mockReturnValue(NOW + 300_000);
    await expect(hrSelf.assertStillAuthorized()).rejects.toThrow("已過期");
    await expect(assertHrLineDeliveryAuthorized(db(), env, input, authorization, HR_KEYS)).rejects.toThrow("已過期");
    await expect(hrSelf.annualLeave()).rejects.toThrow("先呼叫 hr_authorize");
    await expect(service().annualLeave()).rejects.toThrow("先呼叫 hr_authorize");
  });
});

describe("HR 本人假單與特休 view", () => {
  it("未核准只查 pending，無日期不漏掉更早的待審", async () => {
    await seedLeave("old-pending", "alice", { startsOn: "2025-01-01", endsOn: "2025-01-02" });
    await seedLeave("rejected", "alice", { status: "rejected" });
    await seedLeave("cancelled", "alice", { status: "cancelled" });
    const result = await listHrSelfToolLeaveRequests(db(), "alice", { status: "pending" }, NOW);
    expect(result.requests.map((row) => row.id)).toEqual(["old-pending"]);
    expect(result.filters.fromDate).toBeNull();
  });

  it("台北申請日正確處理 UTC 邊界，請假區間採重疊", async () => {
    await seedLeave("before", "alice", { createdAt: "2026-03-01 15:59:59" });
    await seedLeave("inside", "alice", { createdAt: "2026-03-01T16:00:00.000Z", startsOn: "2026-03-01", endsOn: "2026-03-04" });
    const submitted = await listHrSelfToolLeaveRequests(db(), "alice", { dateField: "submitted", fromDate: "2026-03-02", toDate: "2026-03-02" }, NOW);
    expect(submitted.requests.map((row) => row.id)).toEqual(["inside"]);
    const leave = await listHrSelfToolLeaveRequests(db(), "alice", { fromDate: "2026-03-03", toDate: "2026-03-03" }, NOW);
    expect(leave.requests.map((row) => row.id)).toEqual(["inside"]);
  });

  it("同日混合 SQLite 與 ISO UTC 格式依實際申請時間排序，保留毫秒精度", async () => {
    await seedLeave("latest-sql", "alice", { createdAt: "2026-03-01 23:00:00" });
    await seedLeave("z-later-iso", "alice", { createdAt: "2026-03-01T01:00:00.900Z" });
    await seedLeave("a-earlier-iso", "alice", { createdAt: "2026-03-01T01:00:00.100Z" });
    await seedLeave("earliest-sql", "alice", { createdAt: "2026-03-01 00:00:00" });

    const result = await listHrSelfToolLeaveRequests(db(), "alice", {
      status: "pending", dateField: "submitted", fromDate: "2026-03-01", toDate: "2026-03-02",
    }, NOW);
    expect(result.requests.map((row) => row.id)).toEqual(["latest-sql", "z-later-iso", "a-earlier-iso", "earliest-sql"]);
    expect(result.requests.map((row) => row.submittedAt)).toEqual([
      "2026-03-01 23:00:00", "2026-03-01T01:00:00.900Z", "2026-03-01T01:00:00.100Z", "2026-03-01 00:00:00",
    ]);
  });

  it("混合格式的相同時刻以 id 穩定排序，跨頁不漏掉或重複本人假單", async () => {
    const ids = Array.from({ length: 21 }, (_, index) => `same-${String(index).padStart(2, "0")}`);
    for (const [index, id] of [...ids].reverse().entries()) {
      await seedLeave(id, "alice", { createdAt: index % 2 === 0 ? "2026-03-01 16:00:00" : "2026-03-01T16:00:00.000Z" });
    }
    await seedLeave("older", "alice", { createdAt: "2026-03-01T01:00:00.000Z" });
    await seedLeave("bob-latest", "bob", { createdAt: "2026-03-01T23:00:00.000Z" });

    const query = { status: "pending" as const };
    const first = await listHrSelfToolLeaveRequests(db(), "alice", query, NOW);
    const second = await listHrSelfToolLeaveRequests(db(), "alice", { ...query, page: 2 }, NOW);
    expect(first).toMatchObject({ total: 22, page: 1, pageSize: 20, hasMore: true });
    expect(second).toMatchObject({ total: 22, page: 2, hasMore: false });
    expect(first.requests.map((row) => row.id)).toEqual(ids.slice(0, 20));
    expect(second.requests.map((row) => row.id)).toEqual([ids[20], "older"]);
    expect(new Set([...first.requests, ...second.requests].map((row) => row.id)).size).toBe(22);
    expect((await listHrSelfToolLeaveRequests(db(), "alice", query, NOW)).requests.map((row) => row.id)).toEqual(ids.slice(0, 20));
  });

  it("分頁限制與不合法日期不會退回全員或無界查詢", async () => {
    for (let index = 0; index < 22; index++) await seedLeave(`leave-${index}`);
    const first = await listHrSelfToolLeaveRequests(db(), "alice", {}, NOW);
    expect(first.requests).toHaveLength(20); expect(first.total).toBe(22); expect(first.hasMore).toBe(true);
    expect((await listHrSelfToolLeaveRequests(db(), "alice", { page: 2 }, NOW)).requests).toHaveLength(2);
    for (const query of [{ fromDate: "2026-02-30", toDate: "2026-03-02" }, { fromDate: "2026-03-02" }, { page: 0 }, { fromDate: "2025-01-01", toDate: "2026-03-02" }]) {
      await expect(listHrSelfToolLeaveRequests(db(), "alice", query, NOW)).rejects.toThrow();
    }
    await expect(listHrSelfToolLeaveRequests(db(), "", {}, NOW)).rejects.toThrow();
  });

  it("特休只補建本人，當期與到期日正確，待審不扣除，天數依政策換算", async () => {
    await db().update(hrAnnualLeavePolicyVersions).set({ dailyMinutes: 360 });
    await seedLeave("pending-annual");
    const result = await getHrSelfToolAnnualLeave(db(), "alice", NOW);
    expect(result.status).toBe("OK");
    expect(result.periods).toEqual([expect.objectContaining({ periodStart: "2026-03-01", expiresOn: "2027-02-28", dailyMinutes: 360, remainingMinutes: 2520, remainingDays: 7, pendingMinutes: 480 })]);
    expect((await db().select().from(hrAnnualLeaveEntitlements)).every((row) => row.employmentId === "employment-alice")).toBe(true);
    const entitlement = (await db().select().from(hrAnnualLeaveEntitlements).where(eq(hrAnnualLeaveEntitlements.periodStart, "2026-03-01")))[0]!;
    await db().insert(hrAnnualLeaveLedger).values({ id: "debit", entitlementId: entitlement.id, entryKind: "manual_adjustment", deltaHalfHours: -2, sourceKey: "debit", createdBy: "alice" });
    expect((await getHrSelfToolAnnualLeave(db(), "alice", NOW)).periods[0]?.remainingMinutes).toBe(2460);
    expect(JSON.stringify(result)).not.toMatch(/baseAmount|employeeNumber|bob|entitlementId/);
  });

  it("沒有當期額度不宣稱剩餘為零", async () => {
    const result = await getHrSelfToolAnnualLeave(db(), "alice", Date.parse("2025-04-01T00:00:00Z"));
    expect(result).toMatchObject({ status: "NO_CURRENT_ENTITLEMENT", periods: [] });
    expect(result.note).toContain("不代表餘額為零");
  });
});
