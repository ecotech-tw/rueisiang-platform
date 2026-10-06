import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
