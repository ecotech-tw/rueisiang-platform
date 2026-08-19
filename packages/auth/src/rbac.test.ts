import { describe, expect, it } from "vitest";
import type { Permission } from "./permissions.js";
import { type AuthUser, type RoleAssignment, type UserStatus, can, permissionsOf } from "./rbac.js";

function assignment(permissions: Permission[]): RoleAssignment {
  return { roleKey: "test", permissions };
}

function user(
  assignments: RoleAssignment[],
  status: UserStatus = "active",
  directPermissions: Permission[] = [],
): AuthUser {
  return {
    id: "u1",
    email: "someone@ecotech.tw",
    name: "測試",
    googleName: "測試",
    pictureUrl: "",
    status,
    assignments,
    directPermissions,
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

describe("直接授予的權限", () => {
  it("一個角色都沒有也能靠直接授予拿到權限", () => {
    expect(can(user([], "active", ["tools:payout:run"]), "tools:payout:run")).toBe(true);
  });

  it("跟角色帶來的取聯集", () => {
    const someone = user([assignment(["crm:customer:read"])], "active", ["tools:payout:run"]);
    expect(permissionsOf(someone).sort()).toEqual(["crm:customer:read", "tools:payout:run"]);
  });

  it("重複的不會出現兩次", () => {
    const someone = user([assignment(["crm:customer:read"])], "active", ["crm:customer:read"]);
    expect(permissionsOf(someone)).toEqual(["crm:customer:read"]);
  });

  /*
   * 停權要能一次關掉這個人的所有權限。漏掉直接授予的話，「停用」就會變成
   * 只擋角色、擋不住例外授權——那是最容易被忽略、後果也最嚴重的一種漏。
   */
  it.each([["disabled"], ["invited"]] as const)("%s 的帳號連直接授予的也不算數", (status) => {
    const someone = user([], status, ["tools:payout:run"]);
    expect(can(someone, "tools:payout:run")).toBe(false);
    expect(permissionsOf(someone)).toEqual([]);
  });
});
