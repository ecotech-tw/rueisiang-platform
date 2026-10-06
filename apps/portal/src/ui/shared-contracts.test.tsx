import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ConfirmDialog } from "@rueisiang/ui";
import { Pager } from "../shell/Pager.js";
import { DataTable } from "./DataTable";
import { FilterInput, FilterSelect, FilterToolbar, SearchFilterInput } from "./index.js";

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

  it("renders pagers with shared navigation and page-size contracts", () => {
    const markup = renderToStaticMarkup(
      <Pager
        page={4}
        pageSize={20}
        pageSizes={[10, 20, 50]}
        totalPages={8}
        totalLabel="共 158 筆"
        onPage={() => {}}
        onPageSize={() => {}}
      />,
    );

    expect(markup).toContain('class="pager"');
    expect(markup).toContain('aria-label="每頁筆數"');
    expect(markup).toContain('aria-label="分頁"');
    expect(markup).toContain('class="pager-page active"');
    expect(markup).toContain('aria-current="page"');
  });

  it("renders filters with shared labels and compact control wrappers", () => {
    const inputMarkup = renderToStaticMarkup(
      <FilterInput label="搜尋員工" type="search" placeholder="姓名或員工編號" />,
    );
    const searchMarkup = renderToStaticMarkup(
      <SearchFilterInput label="搜尋" placeholder="搜尋關鍵字" value="王小明" onSearch={() => {}} />,
    );
    const selectMarkup = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/hr/employees"]}>
        <FilterSelect label="狀態" options={[{ value: "all", label: "全部狀態" }]} />
      </MemoryRouter>,
    );

    expect(inputMarkup).toContain('class="filter-control"');
    expect(inputMarkup).toContain('aria-label="搜尋員工"');
    expect(searchMarkup).toContain('class="filter-control"');
    expect(searchMarkup).toContain('class="search-input"');
    expect(selectMarkup).toContain('class="filter-control"');
    expect(selectMarkup).toContain('class="filter-select-control"');
    expect(selectMarkup).toContain('aria-label="狀態"');
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
