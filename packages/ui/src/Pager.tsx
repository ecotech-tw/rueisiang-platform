import { useEffect, useState } from "react";
import { Button } from "./Button.js";

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
 * 中間顯示幾顆頁碼。手機放不下 5 顆（連同前後四顆箭頭要 346px，而畫面只有 375px 且面板還有內距），
 * 縮成 3 顆。
 *
 * 用 matchMedia 而不是 CSS 隱藏多餘的：藏起來的按鈕仍然佔著 tab 順序，鍵盤操作的人會按到看不見的東西。
 */
function useWindowSize(): number {
  const [size, setSize] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 620px)").matches ? 3 : 5,
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 620px)");
    const update = () => setSize(query.matches ? 3 : 5);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return size;
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
  const pages = pageWindow(page, Math.max(totalPages, 1), useWindowSize());
  const atFirst = page <= 1;
  const atLast = page >= totalPages;

  return (
    // 手機上疊成兩列，導覽才不會被推出畫面右緣。
    <div className={`flex items-center justify-between gap-3 border-t border-t-soft-line pt-3.5 max-[760px]:flex-col max-[760px]:items-stretch max-[760px]:gap-2.5 ${className}`.trim()}>
      <div className="flex items-center gap-3.5 max-[760px]:justify-between">
        <span className="muted">{totalLabel}</span>
        <label className="flex items-center gap-1.5 text-[13px] text-muted">
          每頁
          {/* 比一般表單欄位窄，footer 在小螢幕才不會被這個 select 撐寬。 */}
          <span className="select-control inline-flex w-max after:right-2.5 after:h-1.5 after:w-1.5">
            <select
              aria-label="每頁筆數"
              className="dropdown-control min-h-8 rounded-[9px] py-[5px] pr-[30px] pl-2 [background-position:calc(100%-12px)_50%,calc(100%-7px)_50%] [background-size:5px_5px,5px_5px]"
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

      <nav className="flex items-center gap-0.5 max-[760px]:justify-center" aria-label="分頁">
        <Button variant="icon" icon="pageFirst" disabled={atFirst} onClick={() => onPage(1)} title="第一頁" aria-label="第一頁" />
        <Button variant="icon" icon="chevronLeft" disabled={atFirst} onClick={() => onPage(page - 1)} title="上一頁" aria-label="上一頁" />

        {pages.map((value) => (
          <button
            key={value}
            type="button"
            // 目前頁不疊 hover：選中的色調容器本身就是狀態，滑過時不該再變色。
            className={`h-[34px] min-w-[34px] rounded-[999px] border-none px-2 text-[13px] tabular-nums focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-secondary ${value === page ? "bg-brand-soft font-bold text-brand-dark" : "bg-transparent text-ink hover:bg-brand/7"}`}
            aria-current={value === page ? "page" : undefined}
            onClick={() => onPage(value)}
          >
            {value}
          </button>
        ))}

        <Button variant="icon" icon="chevronRight" disabled={atLast} onClick={() => onPage(page + 1)} title="下一頁" aria-label="下一頁" />
        <Button variant="icon" icon="pageLast" disabled={atLast} onClick={() => onPage(totalPages)} title="最後一頁" aria-label="最後一頁" />
      </nav>
    </div>
  );
}
