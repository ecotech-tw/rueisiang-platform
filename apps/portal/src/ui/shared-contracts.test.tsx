import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Alert, ConfirmDialog, Dialog, DropdownSelect, EmptyState, Field, Input, InputSkin, SearchCombobox, SegmentedControl, SelectField, SelectionActionBar, StatusBadge, Textarea, TextField, Tooltip } from "@rueisiang/ui";
import { Pager } from "../shell/Pager.js";
import { SortableHeader } from "../shell/SortableHeader.js";
import { DataTable, TableSkin } from "./DataTable";
import { FilterInput, FilterSelect, FilterToolbar, SEARCH_INPUT_WIDTH, SearchFilterInput } from "./index.js";

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
    const tableClasses = (markup.match(/<table class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
    expect(tableClasses).toEqual(expect.arrayContaining(["data-table", "border-collapse", "payroll-table"]));
    expect(markup).toContain("<thead>");
    expect(markup).toContain("<tbody>");
  });

  it("DataTable 的表頭外觀跟著 TableSkin，scroll={false} 只輸出 table", () => {
    const head = (markup: string) => (markup.match(/<table class="([^"]*)"/)?.[1] ?? "").replaceAll("&gt;", ">").replaceAll("&amp;", "&").split(/\s+/).filter((name) => name.includes("thead_th"));
    const rows = <><thead><tr><th>員工</th></tr></thead><tbody><tr><td>王小明</td></tr></tbody></>;
    const solid = head(renderToStaticMarkup(<DataTable>{rows}</DataTable>));
    const glass = head(renderToStaticMarkup(<TableSkin skin="glass"><DataTable>{rows}</DataTable></TableSkin>));
    expect(solid).toContain("[.table-scroll>&_:where(thead_th)]:bg-paper");
    expect(glass).toContain("[.table-scroll>&_:where(thead_th)]:[box-shadow:var(--shadow-glass-table-head)]");
    expect(glass).not.toContain("[.table-scroll>&_:where(thead_th)]:bg-paper");

    const bare = renderToStaticMarkup(<DataTable scroll={false} className="border-separate">{rows}</DataTable>);
    expect(bare.startsWith("<table ")).toBe(true);
    // 兩個 border-collapse 值同時出現時誰贏要看產生順序，所以呼叫端給了就整組取代。
    expect(bare).not.toContain("border-collapse");
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

  it("Field 的間距由 gap 決定、外距交給呼叫端，列內標籤只在窄的時候出現", () => {
    const root = (markup: string) => markup.match(/^<(?:label|div) data-field="" class="([^"]*)"/)?.[1]?.split(" ") ?? [];
    const plain = renderToStaticMarkup(<TextField label="名稱" />);
    const roomy = renderToStaticMarkup(<TextField label="名稱" gap={8} className="min-w-0" />);
    const stacked = renderToStaticMarkup(<TextField label="金額" stackedLabel="viewport" aria-label="基本薪資金額" />);

    expect(root(plain)).toEqual(expect.arrayContaining(["grid", "gap-1.5"]));
    // 兩個 gap 同時出現時誰贏要看產生順序，所以 gap={8} 必須取代 gap-1.5，不能疊上去。
    expect(root(roomy)).toEqual(expect.arrayContaining(["gap-2", "min-w-0"]));
    expect(root(roomy)).not.toContain("gap-1.5");
    expect([...root(plain), ...root(roomy)].filter((name) => /^-?m[tbxylr]?-/.test(name))).toEqual([]);
    expect(stacked).toMatch(/<span class="hidden max-\[640px\]:block [^"]*">金額<\/span>/);
    expect(renderToStaticMarkup(<Field as="div" label="顏色"><span /></Field>)).toMatch(/^<div data-field=""/);
  });

  it("下拉的玻璃外觀跟著 InputSkin 走，尺寸與最小寬度整組取代預設值", () => {
    const trigger = (markup: string) => markup.match(/<button[^>]*class="([^"]*)"/)?.[1]?.split(" ") ?? [];
    const options = [{ value: "a", label: "甲" }];
    const solid = trigger(renderToStaticMarkup(<DropdownSelect aria-label="狀態" options={options} />));
    const glass = trigger(renderToStaticMarkup(<InputSkin skin="glass"><DropdownSelect aria-label="狀態" options={options} /></InputSkin>));
    const compact = trigger(renderToStaticMarkup(<DropdownSelect aria-label="狀態" size="sm" className="min-w-[180px]" options={options} />));
    expect(solid).toEqual(expect.arrayContaining(["bg-canvas", "border-line", "min-h-(--size-field)", "min-w-0"]));
    expect(glass).toEqual(expect.arrayContaining(["bg-paper/38", "border-transparent"]));
    expect(glass).not.toContain("bg-canvas");
    // 兩個高度或兩個最小寬度同時出現時誰贏要看產生順序，所以 sm 與呼叫端的 min-w 都必須取代預設值。
    expect(compact).toEqual(expect.arrayContaining(["min-h-[34px]", "min-w-[180px]"]));
    expect(compact).not.toContain("min-h-(--size-field)");
    expect(compact).not.toContain("min-w-0");
  });

  it("SearchCombobox 的外框與焦點只畫在外層，裡面的輸入框不另外畫", () => {
    const markup = renderToStaticMarkup(<SearchCombobox items={["甲"]} value={null} onValueChange={() => {}} itemToStringLabel={(item) => item ?? ""} label="分類" placeholder="搜尋分類" emptyLabel="找不到分類" />);
    const group = markup.match(/^<div[^>]*class="([^"]*)"/)?.[1]?.split(" ") ?? [];
    const input = markup.match(/<input[^>]*class="([^"]*)"/)?.[1]?.split(" ") ?? [];
    expect(group).toEqual(expect.arrayContaining(["border", "border-line", "focus-within:border-brand", "min-h-(--size-field)"]));
    expect(input).toEqual(expect.arrayContaining(["border-0", "outline-0", "min-h-[calc(var(--size-field)-2px)]"]));
    // 外層是 Field as="div"，標籤連不到輸入框；沒有這個名稱，螢幕閱讀器只念得到 placeholder。
    expect(markup).toMatch(/<input[^>]*aria-label="分類"/);
    // 沒有選取時 Base UI 不畫清除鈕，所以這裡只看得到展開鈕。
    expect(markup).toContain('aria-label="開啟分類選單"');
  });

  it("輸入框的玻璃外觀只跟著 InputSkin 走、只套日期類欄位，Textarea 的高度整組取代預設", () => {
    const classes = (markup: string) => markup.match(/class="([^"]*)"/)?.[1]?.split(" ") ?? [];
    const solidDate = classes(renderToStaticMarkup(<Input type="date" />));
    const glassDate = classes(renderToStaticMarkup(<InputSkin skin="glass"><Input type="date" /></InputSkin>));
    const glassText = classes(renderToStaticMarkup(<InputSkin skin="glass"><Input /></InputSkin>));
    expect(solidDate).toEqual(expect.arrayContaining(["bg-paper", "border-line"]));
    expect(glassDate).toEqual(expect.arrayContaining(["bg-paper/38", "border-transparent"]));
    expect(glassDate).not.toContain("bg-paper");
    expect(glassText).toContain("bg-paper");

    const plain = classes(renderToStaticMarkup(<Textarea />));
    const tall = classes(renderToStaticMarkup(<Textarea className="min-h-40 max-h-60" />));
    expect(plain).toContain("min-h-24");
    // 兩個 min-h 同時出現時誰贏要看產生順序，所以呼叫端的高度必須取代預設值。
    expect(tall).toEqual(expect.arrayContaining(["min-h-40", "max-h-60"]));
    expect(tall).not.toContain("min-h-24");
    // 斷點前綴的高度只在那個寬度生效，其他寬度仍要有預設值。
    expect(classes(renderToStaticMarkup(<Textarea className="sm:min-h-40" />))).toEqual(expect.arrayContaining(["min-h-24", "sm:min-h-40"]));
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
    expect(markup.match(/^<div class="([^"]*)"/)?.[1]).not.toMatch(/(^|\s)m[tbxy]?-/);
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

  it("StatusBadge 跟 Alert 用同一組色調，色階與 quiet 整組取代 tone", () => {
    const classes = (markup: string) => (markup.match(/^<span class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
    const colors = (names: string[]) => names.filter((name) => /^(bg|text)-(?!\[)/.test(name)).sort();
    const danger = classes(renderToStaticMarkup(<StatusBadge tone="danger">失敗</StatusBadge>));
    const alert = (renderToStaticMarkup(<Alert tone="danger">失敗</Alert>).match(/^<div class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
    expect(colors(danger)).toEqual(colors(alert).filter((name) => name !== "text-[13px]"));
    expect(danger).toContain("font-bold");

    const quiet = classes(renderToStaticMarkup(<StatusBadge tone="danger" quiet>正常</StatusBadge>));
    expect(colors(quiet)).toEqual(["bg-soft-line", "text-muted"]);
    expect(quiet).toContain("font-medium");
    expect(quiet).not.toContain("font-bold");

    const palette = classes(renderToStaticMarkup(<StatusBadge tone="success" palette="sky">包材</StatusBadge>));
    expect(colors(palette)).toEqual(["bg-tone-sky/12", "text-tone-sky"]);
    // 後端擋掉不認得的色階，但舊資料或前端漏補時不能變成沒有底色的裸字。
    expect(colors(classes(renderToStaticMarkup(<StatusBadge palette="unknown">舊</StatusBadge>)))).toEqual(["bg-tone-slate/12", "text-tone-slate"]);
  });

  it("EmptyState 的內距由 size 決定，外距交給呼叫端", () => {
    const normal = renderToStaticMarkup(<EmptyState>沒有資料</EmptyState>);
    const compact = renderToStaticMarkup(<EmptyState size="compact">尚無紀錄</EmptyState>);

    expect(normal).toContain("p-[18px]");
    expect(normal).not.toMatch(/\bm[trblxy]?-/);
    expect(compact).toContain("py-2");
    expect(compact).not.toContain("p-[18px]");
  });

  it("renders filters with shared labels and compact controls", () => {
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

    expect(inputMarkup).toContain('aria-label="搜尋員工"');
    expect(inputMarkup).toContain("py-[7px]");
    expect(inputMarkup).not.toContain("<label");
    expect(searchMarkup).toContain(SEARCH_INPUT_WIDTH);
    expect(selectMarkup).toContain('aria-label="狀態"');
    expect(selectMarkup).toMatch(/^<span class="inline-flex w-max max-w-full min-w-0">/);
  });

  it("renders filters as a form with the shared toolbar contract", () => {
    const markup = renderToStaticMarkup(
      <FilterToolbar aria-label="員工篩選">
        <input name="query" aria-label="搜尋" />
      </FilterToolbar>,
    );

    expect(markup).toContain('<form aria-label="員工篩選" class="');
    expect(markup).toContain("border-b border-line");
    expect(markup).not.toContain("admin-form");
    expect(markup).toContain('name="query"');
  });
});
