import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmDialog } from "@rueisiang/ui";
import { DataTable } from "./DataTable";
import { FilterToolbar } from "./FilterToolbar";

describe("shared HRIS UI contracts", () => {
  it("keeps table modifiers on the intended wrapper and table", () => {
    const markup = renderToStaticMarkup(
      <DataTable className="payroll-table" containerClassName="mobile-table">
        <thead><tr><th>員工</th></tr></thead>
        <tbody><tr><td>王小明</td></tr></tbody>
      </DataTable>,
    );

    expect(markup).toContain('class="table-scroll mobile-table"');
    expect(markup).toContain('class="data-table payroll-table"');
    expect(markup).toContain("<thead>");
    expect(markup).toContain("<tbody>");
  });

  it("keeps confirmation dialogs as shared alertdialog contracts", () => {
    const markup = renderToStaticMarkup(
      <ConfirmDialog title="刪除這筆資料？" onConfirm={() => {}} onCancel={() => {}}>
        <p>這個動作無法復原。</p>
      </ConfirmDialog>,
    );

    expect(markup).toContain('class="modal-card confirm-card"');
    expect(markup).toContain('class="modal-body confirm-body"');
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("取消");
    expect(markup).toContain("確定");
  });

  it("renders filters as a form with the shared toolbar contract", () => {
    const markup = renderToStaticMarkup(
      <FilterToolbar aria-label="員工篩選">
        <input name="query" aria-label="搜尋" />
      </FilterToolbar>,
    );

    expect(markup).toContain('<form aria-label="員工篩選" class="admin-form toolbar">');
    expect(markup).toContain('name="query"');
  });
});
