import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HrProfileDetails } from "./Employees.js";
import type { Profile } from "./api.js";

const employee: Profile["employee"] = { userId: "e", employeeNumber: "E001", displayName: "測試員工", email: "e@example.test", userStatus: "active", employmentStatus: "active", revision: 1 };

describe("人事資料呈現", () => {
  it("未任職與未指派都呈現明確空狀態", () => {
    const html = renderToStaticMarkup(<HrProfileDetails profile={{ employee, employments: [], assignments: [] }} />);
    expect(html).toContain("尚無任職紀錄");
    expect(html).toContain("尚未指派辦公位置");
    expect(html).toContain("停用帳號不會刪除任職歷史");
  });

  it("內頁將敏感資料與出勤資料拆成獨立收合區塊", () => {
    const html = renderToStaticMarkup(<HrProfileDetails profile={{ employee, employments: [], assignments: [] }} collapsible />);
    expect(html.match(/hr-profile-section-toggle/g)).toHaveLength(7);
    expect(html).toContain(">任職</span>");
    expect(html).toContain(">薪資</span>");
    expect(html).toContain(">勞健保</span>");
    expect(html).toContain(">辦公位置摘要</span>");
    expect(html).toContain(">打卡紀錄</span>");
    expect(html).not.toContain("資料管理");
    expect(html).not.toContain("設為主要");
  });

  it("顯示已撤銷任職而不把它誤當成離職日期", () => {
    const html = renderToStaticMarkup(<HrProfileDetails profile={{ employee: { ...employee, employmentStatus: "inactive" }, employments: [{ id: "revoked", employeeUserId: "e", hiredOn: "2026-01-01", endedOn: null, seniorityStartOn: "2026-01-01", revokedAt: "2026-01-02 00:00:00", revision: 2 }], assignments: [] }} />);
    expect(html).toContain("已撤銷");
    expect(html).not.toContain("<td>未設定</td>");
  });

  it("呈現復職歷史與半開期間，姓名不解析為 HTML", () => {
    const profile: Profile = {
      employee: { ...employee, displayName: "<script>alert(1)</script>" },
      employments: [
        { id: "j1", employeeUserId: "e", hiredOn: "2026-01-01", endedOn: "2026-02-01", seniorityStartOn: "2026-01-01", revision: 2 },
        { id: "j2", employeeUserId: "e", hiredOn: "2026-03-01", endedOn: null, seniorityStartOn: "2026-01-01", revision: 1 },
      ],
      assignments: [{ id: "a", employmentId: "j2", scopeName: "測試櫃", validFrom: "2026-03-01", validTo: null, revision: 1 }],
      attendanceAssignments: [{ id: "office-a", employmentId: "j2", locationId: "office", locationName: "台北辦公室", validFrom: "2026-03-01", validTo: null, revision: 1 }],
    };
    const html = renderToStaticMarkup(<HrProfileDetails profile={profile} />);
    expect(html).toContain("不再任職首日");
    expect(html).toContain("迄日（不含）");
    expect(html).toContain("2026-02-01");
    expect(html).toContain("<td>測試櫃</td>");
    expect(html).toContain("<td>台北辦公室</td>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
