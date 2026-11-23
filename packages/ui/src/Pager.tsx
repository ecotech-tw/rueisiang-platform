import { Button } from "./Button.js";
import { GLASS_FIELD, useInputSkin, type InputSkinName } from "./InputSkin.js";

// 每頁筆數是原生 select，跟 DropdownSelect 用同一套實心／玻璃外觀。
const PAGE_SIZE_SKIN: Record<InputSkinName, string> = {
  solid: "border-line bg-canvas focus-visible:border-brand focus-visible:outline-0 focus-visible:[box-shadow:var(--shadow-focus-ring)]",
  glass: GLASS_FIELD,
};

export interface PagerProps {
  page: number;
  pageSize: number;
  pageSizes: readonly number[];
  totalPages: number;
  /** 例如「共 10,708 筆」。放左邊，跟導覽分開。 */
  totalLabel: string;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  className?: string;
}

/**
 * 中間要顯示哪幾個頁碼。
 *
 * 固定顯示 5 個，而且會夾在頭尾之間——靠近第一頁時往後補、靠近最後一頁時往前補，
 * 這樣按鈕的數量與位置不會隨著翻頁跳動（跳動的話滑鼠就得一直重新瞄準）。
 */
function pageWindow(current: number, total: number, size = 5): number[] {
  if (total <= size) return Array.from({ length: total }, (_, index) => index + 1);

  const half = Math.floor(size / 2);
  const start = Math.min(Math.max(current - half, 1), total - size + 1);
  return Array.from({ length: size }, (_, index) => start + index);
}

/**
 * 分頁器。`|<  <  4 5 6 7 8  >  >|` ＋ 每頁筆數。
 *
 * 每頁筆數跟「第幾頁」是同一件事的兩面，放在同一個 footer 讓列表操作不必在上下區域來回尋找。
 */
export function Pager({
  page,
  pageSize,
  pageSizes,
  totalPages,
  totalLabel,
  onPage,
  onPageSize,
  className = "",
}: PagerProps) {
  const pages = pageWindow(page, Math.max(totalPages, 1));
  const skin = useInputSkin();
  const atFirst = page <= 1;
  const atLast = page >= totalPages;

  return (
    /*
     * 手機上整頁捲，分頁列黏在捲動區底端，翻到哪裡都看得到總筆數、換得了頁。黏住的那一條要矮：
     * 收成一列，頁碼換成「目前／總頁數」，每頁筆數收起來（手機上照預設值）。背景帶撐到畫面兩側（--bleed）。
     * 頁面有浮動新增鈕時，右側留出它的位置，鈕就嵌在這一列的右端。
     */
    <div data-pager="" className={`flex items-center justify-between gap-3 border-t border-t-soft-line pt-3.5 max-[760px]:sticky max-[760px]:bottom-[calc(var(--page-pad-bottom,0px)*-1)] max-[760px]:z-4 max-[760px]:mx-[calc(var(--bleed,0px)*-1)] max-[760px]:gap-2 max-[760px]:bg-canvas/90 max-[760px]:px-[var(--bleed,0px)] max-[760px]:py-2 max-[760px]:[-webkit-backdrop-filter:blur(12px)] max-[760px]:[backdrop-filter:blur(12px)] max-[760px]:[body:has([data-fab])_&]:pr-[calc(var(--bleed,0px)+56px)] ${className}`.trim()}>
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="truncate text-muted">{totalLabel}</span>
        <label className="flex items-center gap-1.5 text-[13px] text-muted max-[760px]:hidden">
          每頁
          {/* 比一般表單欄位窄，footer 在小螢幕才不會被這個 select 撐寬。 */}
          <span className="relative inline-flex w-max min-w-0 after:pointer-events-none after:absolute after:top-[calc(50%-4px)] after:right-2.5 after:h-1.5 after:w-1.5 after:border-r-2 after:border-b-2 after:border-muted after:[transform:rotate(45deg)]">
            <select
              aria-label="每頁筆數"
              className={`min-h-8 w-full min-w-0 cursor-pointer appearance-none rounded-[9px] border py-[5px] pr-[30px] pl-2 text-ink ${PAGE_SIZE_SKIN[skin]}`}
              value={String(pageSize)}
              onChange={(event) => onPageSize(Number(event.target.value))}
            >
              {pageSizes.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </span>
          筆
        </label>
      </div>

      <nav className="flex items-center gap-0.5" aria-label="分頁">
        <Button variant="icon" icon="pageFirst" disabled={atFirst} onClick={() => onPage(1)} title="第一頁" aria-label="第一頁" />
        <Button variant="icon" icon="chevronLeft" disabled={atFirst} onClick={() => onPage(page - 1)} title="上一頁" aria-label="上一頁" />

        {pages.map((value) => (
          <button
            key={value}
            type="button"
            // 目前頁不疊 hover：選中的色調容器本身就是狀態，滑過時不該再變色。
            className={`h-[34px] min-w-[34px] rounded-[999px] border-none px-2 text-[13px] tabular-nums max-[760px]:hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-secondary ${value === page ? "bg-brand-soft font-bold text-brand-dark" : "bg-transparent text-ink hover:bg-brand/7"}`}
            aria-current={value === page ? "page" : undefined}
            onClick={() => onPage(value)}
          >
            {value}
          </button>
        ))}
        <span className="hidden min-w-[52px] text-center text-[13px] tabular-nums text-ink max-[760px]:inline">{page} / {Math.max(totalPages, 1)}</span>

        <Button variant="icon" icon="chevronRight" disabled={atLast} onClick={() => onPage(page + 1)} title="下一頁" aria-label="下一頁" />
        <Button variant="icon" icon="pageLast" disabled={atLast} onClick={() => onPage(totalPages)} title="最後一頁" aria-label="最後一頁" />
      </nav>
    </div>
  );
}
