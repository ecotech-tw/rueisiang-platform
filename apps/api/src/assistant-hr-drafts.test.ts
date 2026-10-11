import {
  cancelHrRequestDraft, createDatabase, ensureAssistantDefaults, ensureAssistantLineChannel, getHrRequestDraft, hrRequestDraftHint,
  listAssistantChannelTools, listAssistantToolConfigs, saveHrRequestDraft, setAssistantChannelTools, syncSystemRoles, type HrRequestDraftScope,
} from "@rueisiang/db";
import { assistantHrRequestDrafts, hrEmployments, hrLeaveRequests, hrLeaveTypes, users } from "@rueisiang/db/schema";
import { HR_TOOL_DEFINITIONS, isHrToolKey, PLATFORM_TOOL_DEFAULT_STATUSES, PLATFORM_TOOL_KEYS, PLATFORM_TOOL_MAP, toolKeysForLineSource } from "@rueisiang/tools";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

// 台北 2026-03-02（週一）08:00。
const NOW = Date.parse("2026-03-02T00:00:00Z");
const HOUR = 60 * 60 * 1000;
let d1: LocalD1;
const db = () => createDatabase(d1 as never);
const scope: HrRequestDraftScope = { assistantKey: "xiaoxiang", surface: "sandbox", channelKey: null, conversationKey: "session-1", userId: "alice", actorUserId: "admin" };
// 一般辦公：09:00–18:00，12:00–13:00 午休。週二上午三小時。
const complete = { kind: "leave", leaveTypeId: "leave-personal", startsAt: "2026-03-03 09:00", endsAt: "2026-03-03 12:00", reason: "看醫生" };

beforeEach(async () => {
  d1 = createLocalD1();
  await syncSystemRoles(db());
  await db().insert(users).values(["admin", "alice", "bob"].map((id) => ({ id, email: `${id}@example.test`, displayName: id, status: "active" })));
  for (const id of ["alice", "bob"]) {
    await db().insert(hrEmployments).values({ id: `employment-${id}`, employeeUserId: id, employeeNumber: id, legalName: `員工-${id}` });
  }
  await db().insert(hrLeaveTypes).values([
    { id: "leave-personal", name: "事假", leaveKind: "other", createdBy: "admin" },
    { id: "leave-sick", name: "病假", leaveKind: "other", createdBy: "admin" },
    { id: "leave-retired", name: "停用假", leaveKind: "other", active: 0, createdBy: "admin" },
  ]);
});
afterEach(() => { d1.sqlite.close(); });

describe("小香 HR 申請草稿", () => {
  it("一輪一輪把欄位補齊：缺什麼就回什麼，齊了才是 ready 並排出固定格式的卡片", async () => {
    expect(await getHrRequestDraft(db(), scope, NOW)).toBeNull();
    const first = await saveHrRequestDraft(db(), scope, { kind: "leave" }, NOW);
    expect(first).toMatchObject({ kind: "leave", kindLabel: "請假", status: "collecting", missing: ["leaveTypeId", "startsAt", "endsAt", "reason"], card: null });
    expect(first.leaveTypeOptions.map((option) => option.name)).toEqual(["事假", "病假"]);

    const second = await saveHrRequestDraft(db(), scope, { kind: "leave", startsAt: "2026-03-03 09:00", endsAt: "2026-03-03 12:00" }, NOW);
    expect(second).toMatchObject({ id: first.id, status: "collecting", missing: ["leaveTypeId", "reason"], fields: { durationMinutes: 180 } });

    const third = await saveHrRequestDraft(db(), scope, { kind: "leave", leaveTypeId: "leave-personal", reason: "  看醫生  " }, NOW);
    expect(third).toMatchObject({ id: first.id, status: "ready", missing: [], leaveTypeOptions: [], problem: null });
    expect(third.card).toBe("請假申請（尚未送出）\n假別：事假\n開始：2026-03-03（週二）09:00\n結束：2026-03-03（週二）12:00\n時數：3 小時\n原因：看醫生");
    expect(await getHrRequestDraft(db(), scope, NOW)).toEqual(third);
    expect((await db().select().from(assistantHrRequestDrafts))[0]).toMatchObject({ status: "open", revision: 3, userId: "alice", actorUserId: "admin", channelKey: null });
  });

  it("存草稿不會建立任何 HR 申請", async () => {
    await saveHrRequestDraft(db(), scope, complete, NOW);
    expect(await db().select().from(hrLeaveRequests)).toHaveLength(0);
  });

  it("不合法的欄位整次不存，草稿維持上一次的樣子，錯誤訊息講得出要問什麼", async () => {
    await saveHrRequestDraft(db(), scope, { kind: "leave", leaveTypeId: "leave-personal", startsAt: "2026-03-03 09:00" }, NOW);
    const before = await getHrRequestDraft(db(), scope, NOW);
    await expect(saveHrRequestDraft(db(), scope, { kind: "leave", leaveTypeId: "leave-retired" }, NOW)).rejects.toThrow("事假（leave-personal）、病假（leave-sick）");
    await expect(saveHrRequestDraft(db(), scope, { kind: "leave", endsAt: "3/3 中午" }, NOW)).rejects.toThrow("YYYY-MM-DD HH:mm");
    await expect(saveHrRequestDraft(db(), scope, { kind: "leave", endsAt: "2026-02-30 12:00" }, NOW)).rejects.toThrow("不是有效的日期時間");
    // 結束早於開始、整段落在午休：由 HR 自己的試算擋下來，連同這一次一起帶來的原因也不會存進去。
    await expect(saveHrRequestDraft(db(), scope, { kind: "leave", reason: "補一句原因", endsAt: "2026-03-03 08:00" }, NOW)).rejects.toThrow();
    await expect(saveHrRequestDraft(db(), scope, { kind: "leave", startsAt: "2026-03-03 12:00", endsAt: "2026-03-03 13:00" }, NOW)).rejects.toThrow("0.5 小時");
    await expect(saveHrRequestDraft(db(), scope, { kind: "leave", reason: "長".repeat(1001) }, NOW)).rejects.toThrow("1000 字");
    expect(await getHrRequestDraft(db(), scope, NOW)).toEqual(before);
  });

  it("目前只收請假；已經有一張草稿時不能改開別種，要先取消", async () => {
    await expect(saveHrRequestDraft(db(), scope, { kind: "overtime" }, NOW)).rejects.toThrow("目前只能透過小香申請請假");
    await expect(saveHrRequestDraft(db(), scope, { kind: "resign" }, NOW)).rejects.toThrow("目前只能透過小香申請請假");
    await saveHrRequestDraft(db(), scope, { kind: "leave" }, NOW);
    // 模擬日後開放加班：別種的草稿佔著時，新的請假要被擋下並提醒。
    d1.sqlite.prepare("UPDATE assistant_hr_request_drafts SET kind='overtime'").run();
    await expect(saveHrRequestDraft(db(), scope, { kind: "leave" }, NOW)).rejects.toThrow("已經有一張還沒完成的加班草稿");
    expect(await cancelHrRequestDraft(db(), scope, NOW)).toEqual({ cancelled: true, kindLabel: "加班" });
    expect(await saveHrRequestDraft(db(), scope, { kind: "leave" }, NOW)).toMatchObject({ kind: "leave", status: "collecting" });
  });

  it("取消後就沒有草稿，再取消一次照實回沒有；歷史列留著", async () => {
    await saveHrRequestDraft(db(), scope, complete, NOW);
    expect(await cancelHrRequestDraft(db(), scope, NOW)).toEqual({ cancelled: true, kindLabel: "請假" });
    expect(await getHrRequestDraft(db(), scope, NOW)).toBeNull();
    expect(await cancelHrRequestDraft(db(), scope, NOW)).toEqual({ cancelled: false, kindLabel: null });
    const next = await saveHrRequestDraft(db(), scope, { kind: "leave" }, NOW);
    expect(next.missing).toHaveLength(4);
    expect((await db().select().from(assistantHrRequestDrafts)).map((row) => row.status).sort()).toEqual(["cancelled", "open"]);
  });

  it("24 小時沒動就當作沒有草稿；每次存都往後延，過期的不會擋住新草稿", async () => {
    await saveHrRequestDraft(db(), scope, { kind: "leave", reason: "舊的" }, NOW);
    await saveHrRequestDraft(db(), scope, { kind: "leave", leaveTypeId: "leave-sick" }, NOW + 23 * HOUR);
    expect(await getHrRequestDraft(db(), scope, NOW + 46 * HOUR)).toMatchObject({ fields: { reason: "舊的", leaveTypeName: "病假" } });
    expect(await getHrRequestDraft(db(), scope, NOW + 48 * HOUR)).toBeNull();
    expect(await hrRequestDraftHint(db(), scope, NOW + 48 * HOUR)).toBeNull();
    const fresh = await saveHrRequestDraft(db(), scope, { kind: "leave" }, NOW + 48 * HOUR);
    expect(fresh.fields).toMatchObject({ reason: null, leaveTypeId: null });
  });

  it("草稿只屬於這段對話與這位員工：別段對話看不到，同一段對話換了人會被擋", async () => {
    await saveHrRequestDraft(db(), scope, complete, NOW);
    expect(await getHrRequestDraft(db(), { ...scope, conversationKey: "session-2" }, NOW)).toBeNull();
    expect(await getHrRequestDraft(db(), { ...scope, surface: "line", channelKey: "xiaoxiang" }, NOW)).toBeNull();
    await expect(getHrRequestDraft(db(), { ...scope, userId: "bob" }, NOW)).rejects.toThrow("另一位員工");
    await expect(saveHrRequestDraft(db(), { ...scope, userId: "bob" }, { kind: "leave" }, NOW)).rejects.toThrow("另一位員工");
    await expect(cancelHrRequestDraft(db(), { ...scope, userId: "bob" }, NOW)).rejects.toThrow("另一位員工");
  });

  it("LINE 的草稿要指向真的 channel，Sandbox 的不能帶 channel", async () => {
    await ensureAssistantLineChannel(db(), { assistantKey: "xiaoxiang" });
    const line: HrRequestDraftScope = { assistantKey: "xiaoxiang", surface: "line", channelKey: "xiaoxiang", conversationKey: "group-row-1", userId: "alice" };
    expect(await saveHrRequestDraft(db(), line, { kind: "leave" }, NOW)).toMatchObject({ status: "collecting" });
    await expect(saveHrRequestDraft(db(), { ...line, conversationKey: "group-row-2", channelKey: "no-such-channel" }, { kind: "leave" }, NOW)).rejects.toThrow();
    await expect(saveHrRequestDraft(db(), { ...line, conversationKey: "group-row-3", channelKey: null }, { kind: "leave" }, NOW)).rejects.toThrow();
    await expect(saveHrRequestDraft(db(), { ...scope, conversationKey: "session-9", channelKey: "xiaoxiang" }, { kind: "leave" }, NOW)).rejects.toThrow();
  });

  it("提醒只講有草稿與種類，不帶任何欄位；草稿不是這個人的就不提", async () => {
    expect(await hrRequestDraftHint(db(), scope, NOW)).toBeNull();
    await saveHrRequestDraft(db(), scope, complete, NOW);
    expect(await hrRequestDraftHint(db(), scope, NOW)).toEqual({ kind: "leave", kindLabel: "請假" });
    expect(await hrRequestDraftHint(db(), { ...scope, userId: "bob" }, NOW)).toBeNull();
  });

  it("存下來的狀態只有開著與結束；齊不齊每次讀都重算，不會留下一個過期的「已齊全」", async () => {
    await saveHrRequestDraft(db(), scope, complete, NOW);
    const stored = async () => (await db().select().from(assistantHrRequestDrafts))[0]!.status;
    expect(await stored()).toBe("open");
    await db().update(hrLeaveTypes).set({ active: 0 }).where(eq(hrLeaveTypes.id, "leave-personal"));
    expect((await getHrRequestDraft(db(), scope, NOW))!.status).toBe("collecting");
    expect(await stored()).toBe("open");
  });

  it("草稿裡留的是員工講的台北時間，交給 HR 試算前才轉成 UTC", async () => {
    const draft = await saveHrRequestDraft(db(), scope, complete, NOW);
    expect(JSON.parse((await db().select().from(assistantHrRequestDrafts))[0]!.payloadJson)).toMatchObject({ startsAt: "2026-03-03 09:00", endsAt: "2026-03-03 12:00" });
    // 一般辦公 09:00–18:00。台北 09:00–12:00 是三小時；被當成 UTC 的話是台北 17:00–20:00，只剩一小時。
    expect(draft.fields.durationMinutes).toBe(180);
    // 台北凌晨一點在 UTC 還是前一天：日期也要跟著對。
    const overnight = await saveHrRequestDraft(db(), { ...scope, conversationKey: "session-night" }, { kind: "leave", startsAt: "2026-03-03 01:00", endsAt: "2026-03-03 10:00" }, NOW);
    expect(overnight.fields).toMatchObject({ startsAt: "2026-03-03 01:00", durationMinutes: 60 });
  });

  it("同一個對話鍵值在別的 assistant 底下是另一張草稿，互相讀不到也改不到", async () => {
    await saveHrRequestDraft(db(), scope, complete, NOW);
    const other = { ...scope, assistantKey: "another-assistant" };
    expect(await getHrRequestDraft(db(), other, NOW)).toBeNull();
    expect(await hrRequestDraftHint(db(), other, NOW)).toBeNull();
    expect(await cancelHrRequestDraft(db(), other, NOW)).toEqual({ cancelled: false, kindLabel: null });
    expect(await saveHrRequestDraft(db(), other, { kind: "leave", reason: "另一張" }, NOW)).toMatchObject({ fields: { reason: "另一張", leaveTypeId: null } });
    expect((await getHrRequestDraft(db(), scope, NOW))!.fields.reason).toBe("看醫生");
  });

  it("同一段對話的兩輪同時存：不會有一輪的內容被靜靜蓋掉", async () => {
    await saveHrRequestDraft(db(), scope, { kind: "leave" }, NOW);
    const results = await Promise.allSettled([
      saveHrRequestDraft(db(), scope, { kind: "leave", reason: "第一輪" }, NOW),
      saveHrRequestDraft(db(), scope, { kind: "leave", leaveTypeId: "leave-sick" }, NOW),
    ]);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    const draft = await getHrRequestDraft(db(), scope, NOW);
    if (rejected.length) {
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0]!.reason)).toContain("重新讀取草稿");
    } else {
      expect(draft!.fields).toMatchObject({ reason: "第一輪", leaveTypeId: "leave-sick" });
    }
    expect(await db().select().from(assistantHrRequestDrafts)).toHaveLength(1);
  });

  it("草稿存好之後假別被停用或時段變得不能請：讀出來會退回 collecting 並說明原因", async () => {
    await saveHrRequestDraft(db(), scope, complete, NOW);
    await db().update(hrLeaveTypes).set({ active: 0 }).where(eq(hrLeaveTypes.id, "leave-personal"));
    expect(await getHrRequestDraft(db(), scope, NOW)).toMatchObject({ status: "collecting", missing: ["leaveTypeId"], card: null, fields: { leaveTypeId: null } });
    await db().update(hrLeaveTypes).set({ active: 1 }).where(eq(hrLeaveTypes.id, "leave-personal"));
    await db().update(hrEmployments).set({ archivedAt: "2026-03-01" }).where(eq(hrEmployments.id, "employment-alice"));
    const stale = await getHrRequestDraft(db(), scope, NOW);
    expect(stale).toMatchObject({ status: "collecting", card: null, fields: { durationMinutes: null } });
    expect(stale!.problem).toContain("任職期間");
  });
});

describe("工具超過二十個時的授權寫入", () => {
  it("建立 channel 的預設授權與後台全選都切批寫，不會撞到 D1 單一語句 100 個參數的上限", async () => {
    const lineKeys = toolKeysForLineSource(PLATFORM_TOOL_KEYS, "user");
    expect(lineKeys.length).toBeGreaterThan(20);
    const channel = await ensureAssistantLineChannel(db(), { assistantKey: "xiaoxiang", defaultToolKeys: lineKeys });
    expect((await listAssistantChannelTools(db(), channel.channelKey)).map((grant) => grant.toolKey).sort()).toEqual([...lineKeys].sort());
    await setAssistantChannelTools(db(), { channelKey: channel.channelKey, toolKeys: [], updatedBy: "admin" });
    const all = await setAssistantChannelTools(db(), { channelKey: channel.channelKey, toolKeys: lineKeys, updatedBy: "admin" });
    expect(all).toHaveLength(lineKeys.length);
  });
});

describe("小香 HR 申請草稿的工具", () => {
  const keys = ["hr_request_draft_get", "hr_request_draft_save", "hr_request_draft_cancel"];

  it("是本人 HR 工具，預設只在 Sandbox 開放；沒有任何「送出」的工具", () => {
    for (const key of keys) {
      const tool = PLATFORM_TOOL_MAP.get(key)!;
      expect(isHrToolKey(key)).toBe(true);
      expect(tool.defaultStatus).toBe("development");
      expect(tool.lineSourceTypes).toEqual(["user"]);
    }
    expect(toolKeysForLineSource(keys, "group")).toEqual([]);
    expect(HR_TOOL_DEFINITIONS.map((tool) => tool.key).filter((key) => /submit|confirm|create|apply/.test(key))).toEqual([]);
    expect(PLATFORM_TOOL_MAP.get("hr_request_draft_save")!.parameters.properties.kind!.enum).toEqual(["leave"]);
  });

  it("第一次寫進設定表時照工具自己的預設狀態，不是一律 enabled；已經設定過的不會被改回去", async () => {
    await ensureAssistantDefaults(db(), { assistantKey: "xiaoxiang", defaultModel: "m", defaultPrompt: "p", toolKeys: ["hr_authorize"], toolDefaultStatuses: PLATFORM_TOOL_DEFAULT_STATUSES });
    d1.sqlite.prepare("UPDATE assistant_tool_configs SET status='disabled' WHERE key='hr_authorize'").run();
    await ensureAssistantDefaults(db(), { assistantKey: "xiaoxiang", defaultModel: "m", defaultPrompt: "p", toolKeys: PLATFORM_TOOL_KEYS, toolDefaultStatuses: PLATFORM_TOOL_DEFAULT_STATUSES });
    const statuses = new Map((await listAssistantToolConfigs(db())).map((tool) => [tool.key, tool.status]));
    for (const key of keys) expect(statuses.get(key)).toBe("development");
    expect(statuses.get("hr_get_my_schedule")).toBe("enabled");
    expect(statuses.get("hr_authorize")).toBe("disabled");
  });

  it("參數只收草稿欄位，轉給授權服務；不能指定對象，也不能在群組用", async () => {
    const calls: unknown[] = [];
    const hrSelf = {
      authorize: async () => ({}),
      requestDraft: async () => { calls.push("get"); return { draft: null }; },
      saveRequestDraft: async (input: unknown) => { calls.push(input); return { draft: {} }; },
      cancelRequestDraft: async () => { calls.push("cancel"); return { cancelled: true }; },
    };
    const context = { surface: "sandbox", services: { hrSelf } } as const;
    await PLATFORM_TOOL_MAP.get("hr_request_draft_get")!.execute({}, context);
    await PLATFORM_TOOL_MAP.get("hr_request_draft_save")!.execute({ kind: "leave", startsAt: "2026-03-03 09:00" }, context);
    await PLATFORM_TOOL_MAP.get("hr_request_draft_cancel")!.execute({}, context);
    expect(calls).toEqual(["get", { kind: "leave", startsAt: "2026-03-03 09:00" }, "cancel"]);
    const save = PLATFORM_TOOL_MAP.get("hr_request_draft_save")!;
    await expect(save.execute({ kind: "leave", userId: "bob" }, context)).rejects.toThrow("不接受查詢對象");
    await expect(save.execute({ startsAt: "2026-03-03 09:00" }, context)).rejects.toThrow("申請種類");
    await expect(save.execute({ kind: "leave", reason: 5 }, context)).rejects.toThrow("參數格式");
    await expect(PLATFORM_TOOL_MAP.get("hr_request_draft_get")!.execute({ id: "x" }, context)).rejects.toThrow("不接受");
    await expect(save.execute({ kind: "leave" }, { surface: "line", lineSourceType: "group", services: { hrSelf } })).rejects.toThrow("僅限 LINE 本人私訊");
    await expect(save.execute({ kind: "leave" }, { surface: "sandbox" })).rejects.toThrow("授權服務不可用");
  });
});
