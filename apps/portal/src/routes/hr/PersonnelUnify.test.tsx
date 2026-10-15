import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "../../ui/DataTable.js";
import { employeeDetailPath, HrEmployees } from "./Employees.js";
import { buildWorkerCompensationSubmission, WorkerCompensationEditor, WorkerCompensationRow } from "./Compensation.js";
import { OvertimeForm } from "./Requests.js";
import type { Employee, ScheduleWorkerRecord } from "./api.js";

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  useHrQuery: vi.fn(),
  useHrWrite: vi.fn(),
  useHrEmployeeRoster: vi.fn(),
}));

vi.mock("../../auth/session.js", () => ({ useSession: mocks.useSession }));
vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    useHrQuery: mocks.useHrQuery,
    useHrWrite: mocks.useHrWrite,
    useHrEmployeeRoster: mocks.useHrEmployeeRoster,
  };
});

const workerPerson: Employee = {
  personKind: "worker",
  employmentId: "worker-1",
  userId: null,
  employeeNumber: "W001",
  legalName: "王支援",
  accountName: "王支援",
  displayName: "王支援",
  email: "",
  position: "排班支援人員",
  supervisorUserId: null,
  supervisorName: null,
  userStatus: "active",
  employmentStatus: "active",
  revision: 1,
};

const compensation = {
  id: "worker-comp-1",
  workerId: "worker-1",
  versionNumber: 1,
  validFrom: "2020-01-01",
  validTo: null,
  payBasis: "hourly" as const,
  baseAmountMinor: 42_000,
  overtimeRatePpm: null,
  overtimeHourlyMinor: 75_000,
  note: "測試敘薪",
};

const worker: ScheduleWorkerRecord = {
  id: "worker-1",
  employmentId: "worker-1",
  displayName: "王支援",
  active: true,
  revision: 1,
  compensation: [compensation],
};

function query(data: unknown) {
  return { data, error: null, isPending: false, isFetching: false, isPlaceholderData: false, refetch: vi.fn() };
}

beforeEach(() => {
  mocks.useSession.mockReturnValue({ user: null, permissions: new Set(["hr:employee:read"]) });
  mocks.useHrQuery.mockImplementation((path: string) => query(path.startsWith("/employees?")
    ? { employees: [workerPerson], total: 1, page: 1, pageSize: 25, hasMore: false, counts: { active: 1, inactive: 0 } }
    : { users: [] }));
  mocks.useHrWrite.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null });
  mocks.useHrEmployeeRoster.mockReturnValue(query({ employees: [workerPerson], total: 1, page: 1, pageSize: 25, hasMore: false }));
});

describe("統一人員名單與支援人員薪資／加班表單", () => {
  it("支援人員的人員內頁路徑使用 canonical 任職 ID，正式員工仍可回退到 userId", () => {
    expect(employeeDetailPath(workerPerson)).toBe("/hr/employees/worker-1");
    expect(employeeDetailPath({ employmentId: undefined, userId: "user/1" })).toBe("/hr/employees/user%2F1");
  });

  it("共用人員列表把支援人員呈現為無平台帳號，並以任職 ID 開啟內頁", () => {
    const markup = renderToStaticMarkup(<MemoryRouter><HrEmployees /></MemoryRouter>);

    expect(mocks.useHrQuery).toHaveBeenCalledWith(expect.stringContaining("personKind=all"), true);
    expect(markup).toContain("王支援");
    expect(markup).toContain("排班支援人員");
    expect(markup).toContain("無平台帳號");
    expect(markup).toContain('role="link" tabindex="0"');
  });

  it("人員列表不顯示狀態說明，長員工編號以省略樣式搭配 Tooltip 呈現", () => {
    const employeeNumber = "W-5927c2239dba447bae0a3bd2b994c7e6";
    mocks.useHrQuery.mockImplementation((path: string) => query(path.startsWith("/employees?")
      ? { employees: [{ ...workerPerson, employeeNumber }], total: 1, page: 1, pageSize: 25, hasMore: false, counts: { active: 1, inactive: 0 } }
      : { users: [] }));

    const markup = renderToStaticMarkup(<MemoryRouter><HrEmployees /></MemoryRouter>);

    expect(markup).not.toContain("LINE 綁定、帳號啟用與在職狀態分開");
    expect(markup).toMatch(/<span class="[^"]*" tabindex="0"><span class="cell-strong hr-employee-number">/);
    expect(markup).toContain("hr-employee-number");
    expect(markup).toContain(employeeNumber);
  });

  it("支援人員敘薪列顯示目前時薪與更新操作", () => {
    const markup = renderToStaticMarkup(
      <DataTable><tbody><WorkerCompensationRow employee={workerPerson} worker={worker} canWrite onEdit={() => {}} /></tbody></DataTable>,
    );

    expect(markup).toContain("排班支援人員");
    expect(markup).toContain("時薪");
    expect(markup).toContain("NT$ 420");
    expect(markup).toContain("固定 NT$ 750／時");
    expect(markup).toContain('aria-label="為王支援更新敘薪版本"');
  });

  it("支援人員敘薪提交使用 canonical employment ID 並換算金額單位", () => {
    expect(buildWorkerCompensationSubmission({
      employmentId: "worker/1", validFrom: "2026-10-01", validTo: "", payBasis: "hourly",
      amount: "420", overtimeMode: "amount", overtimeValue: "750", note: "每小時敘薪",
    })).toEqual({
      ok: true,
      request: {
        path: "/employments/worker%2F1/worker-compensation",
        method: "POST",
        values: { validFrom: "2026-10-01", validTo: null, payBasis: "hourly", baseAmountMinor: 42_000, overtimeRatePpm: null, overtimeHourlyMinor: 75_000, note: "每小時敘薪" },
      },
    });
    expect(buildWorkerCompensationSubmission({
      employmentId: "worker-1", validFrom: "2026-10-01", validTo: "", payBasis: "daily",
      amount: "12.5", overtimeMode: "none", overtimeValue: "", note: "",
    })).toEqual({ ok: false, message: "日薪請填非負整數的金額（元）。" });
  });

  it("支援人員敘薪編輯器依目前版本帶入計薪與加班設定", () => {
    const markup = renderToStaticMarkup(<MemoryRouter initialEntries={["/hr/compensation"]}><WorkerCompensationEditor worker={worker} onClose={() => {}} /></MemoryRouter>);

    expect(markup).toContain("設定 王支援 的敘薪");
    expect(markup).toContain('value="hourly"');
    expect(markup).toContain('value="420"');
    expect(markup).toContain('value="amount"');
    expect(markup).toContain('value="750"');
    expect(markup).toContain("固定加班金額／時（元）");
  });

  it("加班申請表提供支援人員切換與多日／單日模式", () => {
    const markup = renderToStaticMarkup(<MemoryRouter initialEntries={["/hr/requests"]}><OvertimeForm
      employees={[]}
      workers={[{ id: "worker-1", displayName: "王支援" }]}
      actionsSlot={null}
      onClose={() => {}}
      onDone={() => {}}
      onPendingChange={() => {}}
    /></MemoryRouter>);

    expect(markup).toContain('class="hr-request-form"');
    expect(markup).toContain('aria-label="申請對象"');
    expect(markup).toContain("支援人員");
    expect(markup).toContain('aria-label="一次申請幾天"');
    expect(markup).toContain("單日");
    expect(markup).toContain("多日");
  });
});
