import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HrProfileDetails } from "./Employees.js";
import type { Profile } from "./api.js";

const employee: Profile["employee"] = { userId: "e", employeeNumber: "E001", position: "一般職員", displayName: "測試員工", email: "e@example.test", userStatus: "active", employmentStatus: "active", revision: 1 };

describe("人事資料呈現", () => {
  it("未任職與未指派都呈現明確空狀態", () => {
    const html = renderToStaticMarkup(<HrProfileDetails profile={{ employee, employments: [], assignments: [] }} />);
    expect(html).toContain("尚未建立員工資料");
    expect(html).toContain("尚未指派辦公位置");
    expect(html).toContain("員工資料封存後仍保留");
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

  it("封存員工仍呈現主檔資料與封存狀態", () => {
    const html = renderToStaticMarkup(<HrProfileDetails profile={{ employee: { ...employee, employmentStatus: "inactive" }, employments: [{ id: "archived", employeeUserId: "e", employeeNumber: "E001", position: "一般職員", supervisorUserId: null, archivedAt: "2026-01-02 00:00:00", revision: 2 }], assignments: [] }} />);
    expect(html).toContain("已封存");
    expect(html).toContain("2026/1/2");
    expect(html).not.toContain("已撤回");
  });

  it("呈現目前主檔與指派資料，姓名不解析為 HTML", () => {
    const profile: Profile = {
      employee: { ...employee, displayName: "<script>alert(1)</script>" },
      employments: [{ id: "j1", employeeUserId: "e", employeeNumber: "E001", position: "店務主管", supervisorUserId: null, archivedAt: null, attendanceMode: "general", revision: 2 }],
      assignments: [{ id: "a", employmentId: "j1", scopeName: "測試櫃", validFrom: "2026-01-01", validTo: null, revision: 1 }],
      attendanceAssignments: [{ id: "office-a", employmentId: "j1", locationId: "office", locationName: "台北辦公室", validFrom: "2026-01-01", validTo: null, revision: 1 }],
    };
    const html = renderToStaticMarkup(<HrProfileDetails profile={profile} />);
    expect(html).toContain("職位");
    expect(html).toContain("迄日（不含）");
    expect(html).toContain("2026-01-01");
    expect(html).toContain("<td>測試櫃</td>");
    expect(html).toContain("<td>台北辦公室</td>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
