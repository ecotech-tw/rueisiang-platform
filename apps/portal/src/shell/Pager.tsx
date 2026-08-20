import { Icon } from "./icons.js";

/**
 * 分頁器。`|<  <  4 5 6 7 8  >  >|` ＋ 每頁筆數。
 *
 * 原本只有「上一頁／下一頁」，在 429 頁的清單上等於沒有導覽——想回第一頁要按
 * 428 次。每頁筆數本來放在上面的篩選面板裡，但它跟「第幾頁」是同一件事的兩面，
 * 分開放會讓人先在上面改筆數、再滑到下面找頁碼。
 */

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

export function Pager({
  page,
  pageSize,
  pageSizes,
  totalPages,
  totalLabel,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  pageSizes: readonly number[];
  totalPages: number;
  /** 例如「共 10,708 筆」。放左邊，跟導覽分開。 */
  totalLabel: string;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  const pages = pageWindow(page, Math.max(totalPages, 1));
  const atFirst = page <= 1;
  const atLast = page >= totalPages;

  return (
    <div className="pager">
      <div className="pager-meta">
        <span className="muted">{totalLabel}</span>
        <label className="pager-size">
          每頁
          <select
            aria-label="每頁筆數"
            value={String(pageSize)}
            onChange={(event) => onPageSize(Number(event.target.value))}
          >
            {pageSizes.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
          筆
        </label>
      </div>

      <nav className="pager-nav" aria-label="分頁">
        <button type="button" className="icon-button" disabled={atFirst} onClick={() => onPage(1)} title="第一頁" aria-label="第一頁">
          <Icon name="pageFirst" />
        </button>
        <button type="button" className="icon-button" disabled={atFirst} onClick={() => onPage(page - 1)} title="上一頁" aria-label="上一頁">
          <Icon name="chevronLeft" />
        </button>

        {pages.map((value) => (
          <button
            key={value}
            type="button"
            className={`pager-page${value === page ? " active" : ""}`}
            aria-current={value === page ? "page" : undefined}
            onClick={() => onPage(value)}
          >
            {value}
          </button>
        ))}

        <button type="button" className="icon-button" disabled={atLast} onClick={() => onPage(page + 1)} title="下一頁" aria-label="下一頁">
          <Icon name="chevronRight" />
        </button>
        <button type="button" className="icon-button" disabled={atLast} onClick={() => onPage(totalPages)} title="最後一頁" aria-label="最後一頁">
          <Icon name="pageLast" />
        </button>
      </nav>
    </div>
  );
}
