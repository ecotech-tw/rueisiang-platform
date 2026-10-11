import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { emptyHrPersonalData, HR_PROFILE_FIELDS } from "@rueisiang/db/hr-profile-fields";
import { EmployeeProfile } from "./EmployeeProfile.js";
import { type Profile } from "./api.js";

vi.mock("./api.js", () => ({
  useHrQuery: () => ({ data: { users: [] }, isPending: false, error: null }),
  useHrWrite: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
}));

vi.mock("../../shell/Toast.js", () => ({ useToast: () => ({ show: vi.fn() }) }));

const profile: Profile = {
  employee: { userId: "user", personKind: "employee", employeeNumber: "E001", legalName: "測試員工", accountName: "帳號姓名", displayName: "測試員工", email: "employee@example.test", position: "門市人員", userStatus: "active", employmentStatus: "active", revision: 1 },
  employments: [{ id: "employment", employeeUserId: "user", employeeNumber: "E001", position: "門市人員", supervisorUserId: null, serviceStartOn: "2026-01-01", archivedAt: null, revision: 1 }],
  personalData: { ...emptyHrPersonalData(), englishName: "Test Employee", mobilePhone: "0912345678", emergencyName: "<script>test</script>" },
};

describe("員工內頁資料區", () => {
  it("基本、公司與聯絡分區呈現，三個編輯入口都在內頁", () => {
    const markup = renderToStaticMarkup(<EmployeeProfile profile={profile} canWrite onSaved={() => {}} />);
    for (const title of ["基本資料", "公司／任職資料", "聯絡資料"]) expect(markup).toContain(title);
    for (const field of HR_PROFILE_FIELDS) expect(markup).toContain(field.label);
    expect(markup).toContain("Test Employee");
    expect(markup).toContain("0912345678");
    expect(markup).toContain("&lt;script&gt;test&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup.match(/>編輯<\/button>/g)).toHaveLength(3);
    expect(markup).toContain("設為未在職");
    expect(markup.indexOf('id="employee-basic"')).toBeLessThan(markup.indexOf('id="employee-contact"'));
    expect(markup.indexOf('id="employee-contact"')).toBeLessThan(markup.indexOf('id="employee-company"'));
    expect(markup.match(/hr-action-update/g)).toHaveLength(4);
    expect(markup).toContain("上傳大頭貼");
    expect(markup).toContain("尚未上傳大頭貼");
    expect(markup).toContain("靜態照片，最大 5 MB、800 萬像素、單邊 8192 px");
  });

  it("無寫入權限只顯示資料，不顯示編輯與封存入口", () => {
    const markup = renderToStaticMarkup(<EmployeeProfile profile={profile} canWrite={false} onSaved={() => {}} />);
    expect(markup).not.toContain(">編輯</button>");
    expect(markup).not.toContain("設為未在職");
    expect(markup).not.toContain("恢復在職");
    expect(markup).not.toContain("上傳大頭貼</button>");
  });

  it("個資未提供時顯示權限提示，不偽裝為空白可編輯欄位", () => {
    const markup = renderToStaticMarkup(<EmployeeProfile profile={{ ...profile, personalData: undefined }} canWrite onSaved={() => {}} />);
    expect(markup).toContain("聯絡資料僅限全平台 HR 管理者查看");
    expect(markup).not.toContain("身分證／居留證字號");
    expect(markup).not.toContain("上傳大頭貼</button>");
    expect(markup).toContain("員工大頭貼僅限全平台 HR 管理者查看");
    expect(markup).not.toContain("0912345678");
    expect(markup.match(/>編輯<\/button>/g)).toHaveLength(2);
  });

  it("照片只使用受權限保護的 API，顯示更換與移除入口", () => {
    const markup = renderToStaticMarkup(<EmployeeProfile profile={{ ...profile, photo: { id: "photo-version" } }} canWrite onSaved={() => {}} />);
    expect(markup).toContain("/api/hr/employees/employment/photo?v=photo-version");
    expect(markup).toContain("更換大頭貼");
    expect(markup).toContain("移除大頭貼");
  });

  it("未在職只提供恢復入口，保留個資與聯絡資料", () => {
    const archived: Profile = { ...profile, employee: { ...profile.employee, employmentStatus: "inactive" }, employments: profile.employments.map((job) => ({ ...job, archivedAt: "2026-09-01 00:00:00" })) };
    const markup = renderToStaticMarkup(<EmployeeProfile profile={archived} canWrite onSaved={() => {}} />);
    expect(markup).toContain("恢復在職");
    expect(markup).toContain("0912345678");
    expect(markup).not.toContain(">編輯</button>");
  });
});
