import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Alert, ConfirmDialog, Dialog, EmptyState, SegmentedControl, SelectField, SelectionActionBar, Tooltip } from "@rueisiang/ui";
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

    expect(markup).toContain('role="status" aria-live="polite"');
    expect(markup).toContain("已選取 3 筆加班申請");
    expect(markup).toContain("取消並刪除所選加班");
  });

  it("keeps confirmation dialogs as shared alertdialog contracts", () => {
    const markup = renderToStaticMarkup(
      <ConfirmDialog title="刪除這筆資料？" onConfirm={() => {}} onCancel={() => {}}>
        <p>這個動作無法復原。</p>
      </ConfirmDialog>,
    );

    expect(markup).toContain("w-[min(420px,100%)]");
    expect(markup).toContain("grid gap-2 px-6 pb-1");
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("取消");
    expect(markup).toContain("確定");
  });

  it("Dialog 的 bodyLayout 整組取代預設版面，不跟預設的 gap 或 padding 疊在一起", () => {
    const body = (markup: string) => markup.match(/<div class="([^"]*overflow-y-auto[^"]*)"><p>內容<\/p>/)?.[1]?.split(" ") ?? [];
    const plain = body(renderToStaticMarkup(<Dialog title="預設"><p>內容</p></Dialog>));
    const custom = body(renderToStaticMarkup(<Dialog title="自訂" bodyLayout="flex flex-col gap-5 px-6 pb-2"><p>內容</p></Dialog>));

    expect(plain).toEqual(expect.arrayContaining(["grid", "gap-4", "px-6", "pb-2"]));
    expect(custom).toEqual(expect.arrayContaining(["flex", "flex-col", "gap-5"]));
    expect(custom).not.toContain("grid");
    expect(custom).not.toContain("gap-4");
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

    expect(markup).toContain('aria-label="每頁筆數"');
    expect(markup).toContain('aria-label="分頁"');
    // 目前頁的色調容器不能被 hover 蓋掉，所以 hover 只給其他頁。
    const current = markup.match(/<button[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";
    expect(current).toContain("bg-brand-soft");
    expect(current).not.toContain("hover:");
    // 外距由呼叫端決定。
    expect(markup.match(/^<div class="([^"]*)"/)?.[1]).not.toMatch(/(^|s)m[tbxy]?-/);
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
    expect(markup).toMatch(/<button[^>]*class="[^"]*\btext-brand-dark\b/);
    expect(markup).toContain('aria-sort="none"');
    expect(markup).toMatch(/<button[^>]*class="[^"]*\btext-inherit\b/);
  });

  it("SegmentedControl 的皮膚、高度與密度是 prop，選中狀態跟著皮膚走", () => {
    const options = [{ value: "a", label: "甲", badge: "3 筆" }, { value: "b", label: "乙", badge: "0 筆" }];
    const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*class="([^"]*)"[^>]*aria-pressed="(true|false)"/g)].map((match) => ({ classes: (match[1] ?? "").split(/\s+/), pressed: match[2] === "true" }));

    const glass = buttons(renderToStaticMarkup(<SegmentedControl aria-label="檢視" options={options} value="a" onChange={() => {}} />));
    expect(glass.find((button) => button.pressed)?.classes).toContain("bg-paper/56");
    expect(glass.find((button) => !button.pressed)?.classes).toEqual(expect.arrayContaining(["text-muted", "hover:bg-brand/8", "min-h-[38px]"]));
    // 選中的那顆不帶 hover 樣式，hover 才不會把選中的底色蓋掉。
    expect(glass.find((button) => button.pressed)?.classes).not.toContain("hover:bg-brand/8");

    const tabsMarkup = renderToStaticMarkup(<SegmentedControl aria-label="表單" skin="tabs" size="lg" dense options={options} value="a" onChange={() => {}} />);
    const tabs = buttons(tabsMarkup);
    expect(tabs.find((button) => button.pressed)?.classes).toEqual(expect.arrayContaining(["bg-brand-soft", "min-h-10", "max-[760px]:px-1"]));
    expect(tabsMarkup).toMatch(/<span>甲<\/span><small class="[^"]*\bbg-brand\b[^"]*">3 筆<\/small>/);
    expect(tabsMarkup).toMatch(/<span>乙<\/span><small class="[^"]*\btext-muted\b[^"]*">0 筆<\/small>/);
  });

  it("Tooltip 的錨點預設跟內容一樣寬，block 才撐滿整行", () => {
    const anchorClasses = (markup: string) => (markup.match(/^<span class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
    const inline = anchorClasses(renderToStaticMarkup(<Tooltip label="完整數字"><strong>NT$3,011…</strong></Tooltip>));
    const block = anchorClasses(renderToStaticMarkup(<Tooltip block label="完整數字" className="cursor-help"><strong>NT$3,011…</strong></Tooltip>));
    expect(inline).toContain("inline-flex");
    expect(inline).not.toContain("block");
    // 兩個 display utility 同時出現時誰贏要看產生順序，所以 block 必須取代 inline-flex，不能疊上去。
    expect(block).toEqual(expect.arrayContaining(["block", "cursor-help"]));
    expect(block).not.toContain("inline-flex");
  });

  it("Alert 的字級由 size 決定，外距交給呼叫端", () => {
    const rootClasses = (markup: string) => (markup.match(/^<div class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
    const normal = rootClasses(renderToStaticMarkup(<Alert tone="danger">儲存失敗</Alert>));
    const compact = rootClasses(renderToStaticMarkup(<Alert size="compact" tone="success">已打卡</Alert>));
    expect(normal).toEqual(expect.arrayContaining(["text-[13px]", "bg-brand-soft", "text-brand-dark"]));
    expect(compact).toEqual(expect.arrayContaining(["text-[12px]", "bg-ok-soft", "text-ok"]));
    // 兩個字級同時出現時誰贏要看產生順序，所以 compact 必須取代 13px，不能疊上去。
    expect(compact).not.toContain("text-[13px]");
    expect([...normal, ...compact].filter((name) => /^-?m[tbxylr]?-/.test(name))).toEqual([]);
  });

  it("EmptyState 的內距由 size 決定，外距交給呼叫端", () => {
    const normal = renderToStaticMarkup(<EmptyState>沒有資料</EmptyState>);
    const compact = renderToStaticMarkup(<EmptyState size="compact">尚無紀錄</EmptyState>);

    expect(normal).toContain("p-[18px]");
    expect(normal).not.toMatch(/\bm[trblxy]?-/);
    expect(compact).toContain("py-2");
    expect(compact).not.toContain("p-[18px]");
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
