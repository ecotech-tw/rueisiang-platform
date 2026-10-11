import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HrLineBindingStatus, HrProfileDetails } from "./Employees.js";
import type { Profile } from "./api.js";
import { EmployeeSectionNav, employeeSections } from "./EmployeeSectionNav.js";

const employee: Profile["employee"] = { userId: "e", employeeNumber: "E001", position: "一般職員", legalName: "測試員工", accountName: "Google 測試員工", displayName: "測試員工", email: "e@example.test", userStatus: "active", employmentStatus: "active", revision: 1 };

describe("人事資料呈現", () => {
  it("浮動導覽只列出存在的區塊，聯絡在任職之前，支援人員不提供正式員工區塊", () => {
    const profile: Profile = { employee, employments: [], assignments: [] };
    const sections = employeeSections(profile);
    expect(sections.map(({ id }) => id)).toEqual(["employee-photo", "employee-basic", "employee-contact", "employee-company", "employee-compensation", "employee-insurance", "employee-attendance"]);
    const html = renderToStaticMarkup(<EmployeeSectionNav profile={profile} />);
    for (const section of sections) expect(html).toContain(`href="#${section.id}"`);
    expect(html).toContain('aria-current="location"');
    expect(employeeSections({ ...profile, employee: { ...employee, personKind: "worker", userId: null } }).map(({ id }) => id)).toEqual(["employee-basic", "employee-compensation"]);
    expect(employeeSections({ ...profile, employments: Array(2).fill({}) }).at(-1)?.id).toBe("employee-history");
  });

  it("LINE 綁定呈現已綁定、未綁定、不適用與未提供狀態", () => {
    const render = (patch: Partial<Profile["employee"]>) => renderToStaticMarkup(<HrLineBindingStatus employee={{ ...employee, ...patch }} />);
    expect(render({ lineLinkedAt: null })).toContain("未綁定");
    const linked = render({ lineLinkedAt: "2026-01-02 00:00:00", userStatus: "disabled" });
    expect(linked).toContain("已綁定");
    expect(linked).toContain("2026/1/2");
    expect(linked).toContain("08:00:00");
    expect(render({ personKind: "worker", userId: null, lineLinkedAt: null })).toContain("不適用");
    expect(render({})).toContain("狀態未提供");
    expect(render({})).not.toContain("未綁定");
  });

  it("未任職與未指派都呈現明確空狀態", () => {
    const html = renderToStaticMarkup(<HrProfileDetails profile={{ employee, employments: [], assignments: [] }} />);
    expect(html).toContain("尚未建立員工資料");
    expect(html).toContain("尚未指派辦公位置");
    expect(html).toContain("員工不在職後仍保留");
  });

  it("內頁將敘薪、保險、出勤分區，僅較長紀錄預設收合", () => {
    const html = renderToStaticMarkup(<HrProfileDetails profile={{ employee, employments: [], assignments: [] }} />);
    expect(html.match(/class="panel-title"/g)).toHaveLength(4);
    expect(html).toContain(">基本資料</h2>");
    expect(html).toContain(">敘薪資料</h2>");
    expect(html).toContain(">保險資料</h2>");
    expect(html).toContain(">出勤資料</h2>");
    expect(html).toContain("打卡紀錄（最近 200 筆）");
    expect(html).not.toContain("資料管理");
    expect(html).not.toContain("設為主要");
  });

  it("未在職員工仍呈現基本資料與狀態", () => {
    const html = renderToStaticMarkup(<HrProfileDetails profile={{ employee: { ...employee, employmentStatus: "inactive" }, employments: [{ id: "archived", employeeUserId: "e", employeeNumber: "E001", position: "一般職員", supervisorUserId: null, archivedAt: "2026-01-02 00:00:00", revision: 2 }], assignments: [] }} />);
    expect(html).toContain("未在職");
    expect(html).toContain("2026/1/2");
    expect(html.slice(0, html.indexOf("敘薪資料"))).not.toContain("已撤回");
  });

  it("呈現目前主檔與指派資料，姓名不解析為 HTML", () => {
    const profile: Profile = {
      employee: { ...employee, legalName: "<script>alert(1)</script>" },
      employments: [{ id: "j1", employeeUserId: "e", employeeNumber: "E001", position: "店務主管", supervisorUserId: null, archivedAt: null, attendanceMode: "general", revision: 2 }],
      assignments: [{ id: "a", employmentId: "j1", scopeName: "測試櫃", validFrom: "2026-01-01", validTo: null, revision: 1 }],
      attendanceAssignments: [{ id: "office-a", employmentId: "j1", locationId: "office", locationName: "台北辦公室", validFrom: "2026-01-01", validTo: null, revision: 1 }],
    };
    const html = renderToStaticMarkup(<HrProfileDetails profile={profile} />);
    expect(html).toContain("職位");
    expect(html).toContain("迄日（不含）");
    expect(html).toContain("2026-01-01");
    expect(html).toContain('<td data-label="營運據點">測試櫃</td>');
    expect(html).toContain('<td data-label="辦公位置">台北辦公室</td>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
