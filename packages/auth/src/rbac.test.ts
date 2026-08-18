import { describe, expect, it } from "vitest";
import type { Permission } from "./permissions.js";
import {
  GLOBAL_SCOPE,
  type AuthUser,
  type RoleAssignment,
  type UserStatus,
  can,
  canAnywhere,
  permissionsOf,
  scopesFor,
} from "./rbac.js";

function assignment(
  permissions: Permission[],
  scopeType = GLOBAL_SCOPE,
  scopeId = GLOBAL_SCOPE,
): RoleAssignment {
  return { roleKey: "test", permissions, scopeType, scopeId };
}

function user(assignments: RoleAssignment[], status: UserStatus = "active"): AuthUser {
  return {
    id: "u1",
    email: "someone@ecotech.tw",
    name: "測試",
    googleName: "測試",
    pictureUrl: "",
    status,
    assignments,
  };
}

describe("帳號狀態", () => {
  const admin = [assignment(["crm:customer:read"])];

  it("active 才有權限", () => {
    expect(canAnywhere(user(admin, "active"), "crm:customer:read")).toBe(true);
  });

  it("邀請中還不能用", () => {
    expect(canAnywhere(user(admin, "invited"), "crm:customer:read")).toBe(false);
  });

  it("停權後立刻失效", () => {
    const disabled = user(admin, "disabled");
    expect(canAnywhere(disabled, "crm:customer:read")).toBe(false);
    expect(permissionsOf(disabled)).toEqual([]);
    expect(scopesFor(disabled, "crm:customer:read", "store")).toEqual({ kind: "none" });
  });
});

describe("權限判定", () => {
  it("沒被授予的權限就是沒有", () => {
    const staff = user([assignment(["crm:customer:read"])]);
    expect(canAnywhere(staff, "crm:customer:write")).toBe(false);
  });

  it("多個角色的權限會聯集", () => {
    const person = user([
      assignment(["crm:customer:read"]),
      assignment(["wms:inventory:read"], "warehouse", "main"),
    ]);
    expect(permissionsOf(person).sort()).toEqual(["crm:customer:read", "wms:inventory:read"]);
  });
});

describe("資料範圍", () => {
  const scoped = user([
    assignment(["crm:customer:read", "crm:customer:write"], "store", "誠品西門店3F"),
    assignment(["crm:customer:read"], "store", "宏匯廣場1F"),
  ]);

  it("在授予的店別內可以做事", () => {
    expect(can(scoped, "crm:customer:write", { scopeType: "store", scopeId: "誠品西門店3F" })).toBe(true);
  });

  it("換一個店別就不行", () => {
    expect(can(scoped, "crm:customer:write", { scopeType: "store", scopeId: "宏匯廣場1F" })).toBe(false);
  });

  it("完全沒被授予的店別更不行", () => {
    expect(can(scoped, "crm:customer:read", { scopeType: "store", scopeId: "夢時代-7F" })).toBe(false);
  });

  it("不指定範圍時，只要任一範圍有就算有——這是給 sidebar 用的", () => {
    expect(canAnywhere(scoped, "crm:customer:write")).toBe(true);
  });

  it("列出可讀取的店別", () => {
    expect(scopesFor(scoped, "crm:customer:read", "store")).toEqual({
      kind: "some",
      ids: ["誠品西門店3F", "宏匯廣場1F"],
    });
  });

  it("只在一間店有寫入權，範圍就只有那一間", () => {
    expect(scopesFor(scoped, "crm:customer:write", "store")).toEqual({
      kind: "some",
      ids: ["誠品西門店3F"],
    });
  });

  it("全域指派可以滿足任何範圍", () => {
    const boss = user([assignment(["crm:customer:write"])]);
    expect(can(boss, "crm:customer:write", { scopeType: "store", scopeId: "任何一家" })).toBe(true);
    expect(scopesFor(boss, "crm:customer:write", "store")).toEqual({ kind: "all" });
  });

  it("重複的店別只會列出一次", () => {
    const duplicated = user([
      assignment(["crm:customer:read"], "store", "誠品西門店3F"),
      assignment(["crm:customer:read", "crm:tag:read"], "store", "誠品西門店3F"),
    ]);
    expect(scopesFor(duplicated, "crm:customer:read", "store")).toEqual({
      kind: "some",
      ids: ["誠品西門店3F"],
    });
  });

  it("有權限但範圍種類不符，結果是 none 而不是 all", () => {
    // 這一條是關鍵：弄錯的話，只有倉庫權限的人會看到所有店別的資料。
    const warehouseOnly = user([assignment(["wms:inventory:read"], "warehouse", "main")]);
    expect(scopesFor(warehouseOnly, "wms:inventory:read", "store")).toEqual({ kind: "none" });
    expect(scopesFor(warehouseOnly, "wms:inventory:read", "warehouse")).toEqual({
      kind: "some",
      ids: ["main"],
    });
  });

  it("沒有任何相關指派時是 none", () => {
    const nobody = user([assignment(["crm:customer:read"])]);
    expect(scopesFor(nobody, "wms:inventory:write", "warehouse")).toEqual({ kind: "none" });
  });
});
