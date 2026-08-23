import {
  createDatabase,
  ensureAssistantDefaults,
  ensureAssistantLineChannel,
  listAssistantChatToolKeys,
  resolveLineToolKeys,
  setAssistantChannelTools,
  setAssistantChatTools,
  setAssistantGroupToolMode,
  setAssistantToolStatus,
  upsertAssistantLineGroup,
} from "@rueisiang/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalD1 } from "./local-d1/d1.js";

/**
 * LINE 對話拿得到哪些工具＝三層的交集：全域狀態 ∩ channel 白名單 ∩ 對話白名單。
 *
 * 每一層漏掉都是「安靜地放行」——不會報錯，只是把不該給的工具送進模型，然後模型真的去用。
 */

const ASSISTANT_KEY = "rueisiang-xiaoxiang";
const WEATHER = "weather_open_meteo";
const WMS_SEARCH = "wms_search_warehouse";
const CRM_SEARCH = "crm_search_customers";

async function setup() {
  const db = createDatabase(createLocalD1() as never);
  await ensureAssistantDefaults(db, {
    assistantKey: ASSISTANT_KEY,
    defaultModel: "gpt-5.4-mini",
    defaultPrompt: "測試用 prompt",
    toolKeys: [WEATHER, WMS_SEARCH, CRM_SEARCH],
  });
  const channel = await ensureAssistantLineChannel(db, { assistantKey: ASSISTANT_KEY });
  const group = await upsertAssistantLineGroup(db, { channelKey: channel.channelKey, lineGroupId: "C1" });
  // 測試這裡仍明確寫入 enabled，模擬管理者已確認這些工具可在線上使用。
  for (const key of [WEATHER, WMS_SEARCH, CRM_SEARCH]) {
    await setAssistantToolStatus(db, { key, status: "enabled", updatedBy: "eli" });
  }
  return { db, channelKey: channel.channelKey, groupId: group.id };
}

describe("LINE 工具權限的三層交集", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { ctx = await setup(); });

  it("新建 channel 預設授權傳入的全部工具，且內建工具預設已啟用", async () => {
    const db = createDatabase(createLocalD1() as never);
    await ensureAssistantDefaults(db, {
      assistantKey: ASSISTANT_KEY,
      defaultModel: "gpt-5.4-mini",
      defaultPrompt: "測試用 prompt",
      toolKeys: [WEATHER, WMS_SEARCH],
    });
    const channel = await ensureAssistantLineChannel(db, {
      assistantKey: ASSISTANT_KEY,
      defaultToolKeys: [WEATHER, WMS_SEARCH],
    });
    const group = await upsertAssistantLineGroup(db, { channelKey: channel.channelKey, lineGroupId: "C-default" });

    const keys = await resolveLineToolKeys(db, {
      channelKey: channel.channelKey,
      groupId: group.id,
      toolMode: "inherit",
    });
    expect(keys).toEqual([WEATHER, WMS_SEARCH]);
  });

  it("channel 沒授權時一個工具都不給", async () => {
    const keys = await resolveLineToolKeys(ctx.db, {
      channelKey: ctx.channelKey,
      groupId: ctx.groupId,
      toolMode: "inherit",
    });
    expect(keys).toEqual([]);
  });

  it("inherit 的群組拿到 channel 授權的全部", async () => {
    await setAssistantChannelTools(ctx.db, {
      channelKey: ctx.channelKey,
      toolKeys: [WEATHER, WMS_SEARCH],
      updatedBy: "eli",
    });
    const keys = await resolveLineToolKeys(ctx.db, {
      channelKey: ctx.channelKey,
      groupId: ctx.groupId,
      toolMode: "inherit",
    });
    expect(keys.sort()).toEqual([WEATHER, WMS_SEARCH].sort());
  });

  it("開發中的工具就算 channel 授權了也不給——那是 Sandbox 才能用的狀態", async () => {
    await setAssistantChannelTools(ctx.db, {
      channelKey: ctx.channelKey,
      toolKeys: [WEATHER, WMS_SEARCH],
      updatedBy: "eli",
    });
    await setAssistantToolStatus(ctx.db, { key: WMS_SEARCH, status: "development", updatedBy: "eli" });

    const keys = await resolveLineToolKeys(ctx.db, {
      channelKey: ctx.channelKey,
      groupId: ctx.groupId,
      toolMode: "inherit",
    });
    expect(keys).toEqual([WEATHER]);
  });

  it("custom 的群組只拿到自己那份清單", async () => {
    await setAssistantChannelTools(ctx.db, {
      channelKey: ctx.channelKey,
      toolKeys: [WEATHER, WMS_SEARCH, CRM_SEARCH],
      updatedBy: "eli",
    });
    await setAssistantGroupToolMode(ctx.db, { channelKey: ctx.channelKey, id: ctx.groupId, toolMode: "custom" });
    await setAssistantChatTools(ctx.db, {
      channelKey: ctx.channelKey,
      groupId: ctx.groupId,
      toolKeys: [WMS_SEARCH],
      updatedBy: "eli",
    });

    const keys = await resolveLineToolKeys(ctx.db, {
      channelKey: ctx.channelKey,
      groupId: ctx.groupId,
      toolMode: "custom",
    });
    expect(keys).toEqual([WMS_SEARCH]);
  });

  it("對話層要不到 channel 沒給的工具", async () => {
    await setAssistantChannelTools(ctx.db, {
      channelKey: ctx.channelKey,
      toolKeys: [WEATHER],
      updatedBy: "eli",
    });
    const saved = await setAssistantChatTools(ctx.db, {
      channelKey: ctx.channelKey,
      groupId: ctx.groupId,
      toolKeys: [WEATHER, CRM_SEARCH],
      updatedBy: "eli",
    });
    expect(saved).toEqual([WEATHER]);
  });

  it("channel 收回工具時，對話層的授權跟著消失", async () => {
    await setAssistantChannelTools(ctx.db, {
      channelKey: ctx.channelKey,
      toolKeys: [WEATHER, WMS_SEARCH],
      updatedBy: "eli",
    });
    await setAssistantGroupToolMode(ctx.db, { channelKey: ctx.channelKey, id: ctx.groupId, toolMode: "custom" });
    await setAssistantChatTools(ctx.db, {
      channelKey: ctx.channelKey,
      groupId: ctx.groupId,
      toolKeys: [WEATHER, WMS_SEARCH],
      updatedBy: "eli",
    });
    expect(await listAssistantChatToolKeys(ctx.db, ctx.groupId)).toHaveLength(2);

    // 這是設計的重點：對話層的外鍵指向 channel 那一列，CASCADE 自動收乾淨，
    // 不靠任何一段程式記得去清。
    await setAssistantChannelTools(ctx.db, {
      channelKey: ctx.channelKey,
      toolKeys: [WEATHER],
      updatedBy: "eli",
    });
    expect(await listAssistantChatToolKeys(ctx.db, ctx.groupId)).toEqual([WEATHER]);
  });
});
