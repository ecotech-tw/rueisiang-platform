import {
  createDatabase, ensureAssistantDefaults, linkLineAccount, listHrSandboxEmployees, replaceLineAccount,
  setAssistantToolStatus, syncSystemRoles, unlinkLineAccount,
} from "@rueisiang/db";
import { authLineAccountLinks, hrEmployments, hrLeaveRequests, hrLeaveTypes, rolePermissionGrants, roles, userRoleAssignments, users } from "@rueisiang/db/schema";
import { HR_TOOL_DEFINITIONS, PLATFORM_TOOL_MAP } from "@rueisiang/tools";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertHrSandboxDeliveryAuthorized, assertHrSandboxRunAllowed, SandboxHrSelfService } from "./assistant-hr.js";
import type { Env } from "./env.js";
import type { PiSandboxAgentRunRequest } from "./pi-agent-contract.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const NOW = Date.parse("2026-03-02T00:00:00Z");
const HR_KEYS = HR_TOOL_DEFINITIONS.map((tool) => tool.key);
let d1: LocalD1;
let env: Env;
let input: PiSandboxAgentRunRequest;
const db = () => createDatabase(d1 as never);
const service = () => SandboxHrSelfService.create(db(), env, input);

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  d1 = createLocalD1();
  await syncSystemRoles(db());
  await db().insert(users).values(["actor", "alice", "bob"].map((id) => ({ id, email: `${id}@example.test`, displayName: id, status: "active" })));
  await db().insert(userRoleAssignments).values({ userId: "actor", roleId: "role-admin" });
  for (const id of ["alice", "bob"]) {
    await db().insert(hrEmployments).values({ id: `employment-${id}`, employeeUserId: id, employeeNumber: id, legalName: `員工-${id}` });
    await linkLineAccount(db(), id, { channelId: "login", lineUserId: `U-${id}` });
  }
  await db().insert(hrLeaveTypes).values({ id: "leave-type", name: "測試假", leaveKind: "other", createdBy: "actor" });
  await db().insert(hrLeaveRequests).values(["alice", "bob"].map((id) => ({
    id: `leave-${id}`, employmentId: `employment-${id}`, leaveTypeId: "leave-type", leaveType: "測試假", status: "pending" as const,
    startsAt: "2026-03-02 01:00:00", endsAt: "2026-03-02 09:00:00", startsOn: "2026-03-02", endsOn: "2026-03-03",
    durationMinutes: 480, createdBy: id, reason: `不應回傳-${id}`,
  })));
  await ensureAssistantDefaults(db(), { assistantKey: "sandbox-test", defaultModel: "gpt-5.4-mini", defaultPrompt: "測試", toolKeys: HR_KEYS });
  input = {
    assistantKey: "sandbox-test", conversationId: "run", sandboxSessionId: null, actorUserId: "actor", contextGeneration: "run", runId: "run",
    model: "gpt-5.4-mini", systemPrompt: "測試", userText: "查我的待審假單", toolKeys: HR_KEYS, hrSandboxUserId: "alice",
  };
  env = { DB: d1, AUTH_SESSION_SECRET: "sandbox-secret", LINE_LIFF_CHANNEL_ID: "login" } as never;
});
afterEach(() => { vi.restoreAllMocks(); d1.sqlite.close(); });

describe("管理者限定的 HR 模擬本人", () => {
  it("先授權，只能查後端固定的員工，token 與 LINE UID 不回傳模型", async () => {
    const hrSelf = await service();
    await expect(hrSelf.leaveRequests({ status: "pending" })).rejects.toThrow("先呼叫 hr_authorize");
    const context = { surface: "sandbox", services: { hrSelf } } as const;
    const result = await PLATFORM_TOOL_MAP.get("hr_authorize")!.execute({}, context);
    expect(JSON.parse(result)).toMatchObject({ authorized: true });
    expect(result).not.toMatch(/token|U-alice|alice|linkVersion/);
    const leaves = await hrSelf.leaveRequests({ status: "pending" });
    expect(leaves.requests.map((row) => row.id)).toEqual(["leave-alice"]);
    expect(JSON.stringify(leaves)).not.toMatch(/bob|不應回傳/);
    await expect(PLATFORM_TOOL_MAP.get("hr_get_my_leave_requests")!.execute({ userId: "bob" }, context)).rejects.toThrow("不接受查詢對象");
    await expect(PLATFORM_TOOL_MAP.get("hr_authorize")!.execute({}, { surface: "sandbox" })).rejects.toThrow("授權服務不可用");
  });

  it("非管理者在綁定或員工查核前拒絕；只有 Sandbox 寫入權限也不夠", async () => {
    await db().delete(userRoleAssignments).where(eq(userRoleAssignments.userId, "actor"));
    await db().insert(roles).values({ id: "role-sandbox", roleKey: "sandbox-only", name: "測試操作者", isSystem: false });
    await db().insert(rolePermissionGrants).values({ roleId: "role-sandbox", permission: "assistant:sandbox:write" });
    await db().insert(userRoleAssignments).values({ userId: "actor", roleId: "role-sandbox" });
    const queries: string[] = [];
    const prepare = d1.prepare.bind(d1);
    vi.spyOn(d1, "prepare").mockImplementation((query) => { queries.push(query); return prepare(query); });
    await expect(service()).rejects.toThrow("平台管理者");
    expect(queries.join("\n")).not.toMatch(/auth_line_account_links|hr_employments/);
  });

  it.each(["停權操作者", "移除管理角色", "撤銷測試權限", "停權員工", "離職員工", "解除綁定", "替換綁定", "同秒重綁", "停用工具"])("%s 在查詢及送出前立即生效", async (change) => {
    const hrSelf = await service(); await hrSelf.authorize(); const authorization = hrSelf.authorization!;
    if (change === "停權操作者") await db().update(users).set({ status: "disabled" }).where(eq(users.id, "actor"));
    if (change === "移除管理角色") await db().delete(userRoleAssignments).where(eq(userRoleAssignments.userId, "actor"));
    if (change === "撤銷測試權限") d1.sqlite.prepare("DELETE FROM role_permission_grants WHERE role_id = 'role-admin' AND permission = 'assistant:sandbox:write'").run();
    if (change === "停權員工") await db().update(users).set({ status: "disabled" }).where(eq(users.id, "alice"));
    if (change === "離職員工") await db().update(hrEmployments).set({ archivedAt: "2026-03-02" }).where(eq(hrEmployments.id, "employment-alice"));
    if (change === "解除綁定") await unlinkLineAccount(db(), "alice");
    if (change === "替換綁定") await replaceLineAccount(db(), "alice", { channelId: "login", lineUserId: "U-replaced" });
    if (change === "同秒重綁") { await unlinkLineAccount(db(), "alice"); await linkLineAccount(db(), "alice", { channelId: "login", lineUserId: "U-alice" }); }
    if (change === "停用工具") await setAssistantToolStatus(db(), { key: "hr_get_my_leave_requests", status: "disabled", updatedBy: "actor" });
    await expect(hrSelf.leaveRequests({ status: "pending" })).rejects.toThrow();
    await expect(assertHrSandboxDeliveryAuthorized(db(), env, input, authorization)).rejects.toThrow();
  });

  it("未綁定、錯誤 Login channel、未在職不能用模擬模式繞過", async () => {
    await unlinkLineAccount(db(), "alice");
    await expect(service()).rejects.toThrow("帳號綁定");
    await linkLineAccount(db(), "alice", { channelId: "wrong-login", lineUserId: "U-alice" });
    await expect(service()).rejects.toThrow("帳號綁定");
    await replaceLineAccount(db(), "alice", { channelId: "login", lineUserId: "U-alice" });
    await db().update(hrEmployments).set({ archivedAt: "2026-03-02" }).where(eq(hrEmployments.id, "employment-alice"));
    await expect(service()).rejects.toThrow("在職員工");
  });

  it("五分鐘到期、換 run、換目標，舊授權不能用於送出", async () => {
    const hrSelf = await service(); await hrSelf.authorize(); const authorization = hrSelf.authorization!;
    await expect(assertHrSandboxDeliveryAuthorized(db(), env, { ...input, hrSandboxUserId: "bob" }, authorization)).rejects.toThrow("不屬於此回覆");
    await expect(assertHrSandboxDeliveryAuthorized(db(), env, { ...input, runId: "next", conversationId: "next", contextGeneration: "next" }, authorization)).rejects.toThrow("不屬於此回覆");
    vi.mocked(Date.now).mockReturnValue(NOW + 300_000);
    await expect(hrSelf.annualLeave()).rejects.toThrow("先呼叫 hr_authorize");
    await expect(hrSelf.assertStillAuthorized()).rejects.toThrow("已過期");
    await expect(assertHrSandboxDeliveryAuthorized(db(), env, input, authorization)).rejects.toThrow("已過期");
  });

  it("可以跟一般工具、session 與附件混用；沒選員工或缺少 authorize 仍拒絕", async () => {
    for (const patch of [
      { toolKeys: [...HR_KEYS, "crm_search_customers"] }, { toolKeys: ["crm_search_customers"] },
      { sandboxSessionId: "session", conversationId: "session", contextGeneration: "created-at" },
      { attachments: [{ key: "image" }] },
    ]) await expect(assertHrSandboxRunAllowed(db(), env, { ...input, ...patch } as PiSandboxAgentRunRequest)).resolves.toBeUndefined();
    await expect(assertHrSandboxRunAllowed(db(), env, { ...input, toolKeys: ["hr_get_my_annual_leave"] })).rejects.toThrow("hr_authorize");
    await expect(assertHrSandboxRunAllowed(db(), env, { ...input, hrSandboxUserId: " " })).rejects.toThrow("選擇要模擬的員工");
    await expect(assertHrSandboxRunAllowed(db(), { ...env, LINE_LIFF_CHANNEL_ID: undefined }, input)).rejects.toThrow("LINE Login channel");
    // 沒帶 HR 工具就用不到綁定，選了員工也不該整輪失敗。
    await expect(assertHrSandboxRunAllowed(db(), { ...env, LINE_LIFF_CHANNEL_ID: undefined }, { ...input, toolKeys: ["crm_search_customers"] })).resolves.toBeUndefined();
    await expect(SandboxHrSelfService.create(db(), { ...env, LINE_LIFF_CHANNEL_ID: undefined }, { ...input, toolKeys: [] })).rejects.toThrow("LINE Login channel");
  });

  it("開發中 HR 工具可在 Sandbox 測試，不需授權或啟用正式 LINE 對話", async () => {
    await setAssistantToolStatus(db(), { key: "hr_get_my_leave_requests", status: "development", updatedBy: "actor" });
    const hrSelf = await service(); await hrSelf.authorize();
    expect((await hrSelf.leaveRequests({ status: "pending" })).requests.map((row) => row.id)).toEqual(["leave-alice"]);
  });

  it("員工選擇器只回必要欄位，綁定狀態依 Login channel，並支援搜尋及分頁", async () => {
    await replaceLineAccount(db(), "bob", { channelId: "other-channel", lineUserId: "U-bob" });
    const result = await listHrSandboxEmployees(db(), { page: 1, search: "", lineLoginChannelId: "login" });
    expect(result.employees).toEqual([
      { userId: "alice", displayName: "員工-alice", employeeNumber: "alice", userStatus: "active", lineBound: true },
      { userId: "bob", displayName: "員工-bob", employeeNumber: "bob", userStatus: "active", lineBound: false },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/U-alice|U-bob|linkVersion|email|other-channel/);
    expect((await listHrSandboxEmployees(db(), { page: 1, search: "bob", lineLoginChannelId: "login" })).employees).toHaveLength(1);
    expect((await listHrSandboxEmployees(db(), { page: 2, search: "", lineLoginChannelId: "login" })).employees).toHaveLength(0);
    expect((await db().select().from(authLineAccountLinks))).toHaveLength(2);
    for (let index = 0; index < 25; index++) {
      const id = `extra-${index}`;
      await db().insert(users).values({ id, email: `${id}@example.test`, status: "active" });
      await db().insert(hrEmployments).values({ id: `employment-${id}`, employeeUserId: id, employeeNumber: id });
    }
    expect(await listHrSandboxEmployees(db(), { page: 1, search: "" })).toMatchObject({ page: 1, hasMore: true });
    expect((await listHrSandboxEmployees(db(), { page: 2, search: "" })).employees).toHaveLength(2);
  });
});
