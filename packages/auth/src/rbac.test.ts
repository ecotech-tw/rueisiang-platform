import { describe, expect, it } from "vitest";
import type { Permission } from "./permissions.js";
import { type AuthUser, type RoleAssignment, type UserStatus, can, permissionsOf } from "./rbac.js";

function assignment(permissions: Permission[]): RoleAssignment {
  return { roleKey: "test", permissions };
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

describe("can", () => {
  it("有那個權限就是 true", () => {
    expect(can(user([assignment(["crm:customer:read"])]), "crm:customer:read")).toBe(true);
  });

  it("沒有那個權限就是 false", () => {
    expect(can(user([assignment(["crm:customer:read"])]), "crm:customer:write")).toBe(false);
  });

  it("多個角色的權限是聯集", () => {
    const target = user([assignment(["crm:customer:read"]), assignment(["wms:inventory:count"])]);
    expect(can(target, "crm:customer:read")).toBe(true);
    expect(can(target, "wms:inventory:count")).toBe(true);
  });

  it("完全沒有角色的人什麼都不能做", () => {
    expect(can(user([]), "crm:customer:read")).toBe(false);
  });

  it.each<UserStatus>(["invited", "disabled"])("狀態是 %s 的帳號權限一律為零", (status) => {
    // 邀請了還沒登入過、以及被停權的人，即使資料表裡掛著角色也不算數。
    expect(can(user([assignment(["crm:customer:read"])], status), "crm:customer:read")).toBe(false);
  });
});

describe("permissionsOf", () => {
  it("把多個角色的權限去重之後聯集起來", () => {
    const target = user([
      assignment(["crm:customer:read", "crm:tag:read"]),
      assignment(["crm:customer:read", "wms:map:read"]),
    ]);
    expect([...permissionsOf(target)].sort()).toEqual([
      "crm:customer:read",
      "crm:tag:read",
      "wms:map:read",
    ]);
  });

  it("停權的人回空陣列——前端據此把整個 sidebar 收乾淨", () => {
    expect(permissionsOf(user([assignment(["crm:customer:read"])], "disabled"))).toEqual([]);
  });
});
