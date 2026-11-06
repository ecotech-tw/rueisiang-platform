import { describe, expect, it } from "vitest";
import { manualScopeIdFromStoreName, reportManagementScopeIdFromName } from "./cyberbiz-scope.js";

describe("reportManagementScopeIdFromName", () => {
  it("CYBERBIZ 手動管理 scope 使用獨立的 manual ID", () => {
    expect(reportManagementScopeIdFromName("中山店", "cyberbiz")).toBe(manualScopeIdFromStoreName("中山店"));
  });

  it("蝦皮 scope 的 ID 前綴與 SKU mapping 平台一致", () => {
    expect(reportManagementScopeIdFromName("蝦皮賣場", "shopee")).toMatch(/^shopee:store:/u);
  });
});
