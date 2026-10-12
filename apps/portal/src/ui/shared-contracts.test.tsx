import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ConfirmDialog, SelectField, SelectionActionBar } from "@rueisiang/ui";
import { Pager } from "../shell/Pager.js";
import { SortableHeader } from "../shell/SortableHeader.js";
import { DataTable } from "./DataTable";
import { FilterInput, FilterSelect, FilterToolbar, SearchFilterInput } from "./index.js";

describe("shared HRIS UI contracts", () => {
  it("人員未選取時保留指定提示，不冒充第一個選項", () => {
    const markup = renderToStaticMarkup(<MemoryRouter initialEntries={["/hr/scheduling"]}><SelectField aria-label="人員" searchable value="" placeholder="請選擇人員" options={[{ value: "employee", label: "E1・小明" }]} /></MemoryRouter>);
    expect(markup).toContain('placeholder="請選擇人員"');
    expect(markup).not.toContain('placeholder="E1・小明"');
  });

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

  it("renders selected-count actions in the shared live status bar", () => {
    const markup = renderToStaticMarkup(
      <SelectionActionBar count={3} countLabel="筆加班申請">
        <button type="button">取消並刪除所選加班</button>
      </SelectionActionBar>,
    );

    expect(markup).toContain('class="selection-action-bar" role="status" aria-live="polite"');
    expect(markup).toContain("已選取 3 筆加班申請");
    expect(markup).toContain("取消並刪除所選加班");
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

  it("renders sortable headers with shared sort contracts", () => {
    const markup = renderToStaticMarkup(
      <table>
        <thead>
          <tr>
            <SortableHeader label="姓名" field="name" active="name" direction="asc" onSort={() => {}} />
            <SortableHeader label="狀態" field="status" active="name" direction="asc" onSort={() => {}} />
          </tr>
        </thead>
      </table>,
    );

    expect(markup).toContain('aria-sort="ascending"');
    expect(markup).toContain('class="sort-header active"');
    expect(markup).toContain('aria-sort="none"');
    expect(markup).toContain('class="sort-header"');
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
