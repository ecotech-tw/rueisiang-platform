import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface TooltipProps {
  /** 提示內容。純文字；需要標題與段落的是 Material 的 rich tooltip，不要用這個撐。 */
  label: string;
  children: ReactNode;
  className?: string;
}

/** 與錨點的間距，以及貼齊視窗邊界時保留的留白。 */
const GAP = 8;
const MARGIN = 8;

interface AnchorRect {
  centerX: number;
  top: number;
  bottom: number;
}

interface Placement {
  left: number;
  top: number;
}

/**
 * Material 3 的 plain tooltip。
 *
 * 不用瀏覽器原生的 `title`：它有一秒多的延遲、字級與圓角都不歸我們管，
 * 而且在觸控裝置上根本不會出現。這裡 hover 或 focus 就立刻顯示——立刻是
 * 刻意偏離 Material（它有約 500ms 進場延遲），因為這個 tooltip 的主要用途是
 * 讀被截斷的數字，等半秒等於沒有。
 *
 * 位置用 `position: fixed` 加 getBoundingClientRect 算，不是相對定位——
 * KPI 卡與資料表為了做省略號都有 `overflow: hidden`，相對定位的提示會被裁掉。
 */
export function Tooltip({ label, children, className = "" }: TooltipProps) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  function show(event: { currentTarget: HTMLElement }) {
    const rect = event.currentTarget.getBoundingClientRect();
    setAnchor({ centerX: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom });
  }

  function hide() {
    setAnchor(null);
    setPlacement(null);
  }

  /*
   * 量完實際尺寸才定位：寬度要看內容，撞到視窗邊界時得夾回來，上方放不下時要翻到
   * 下方。純 CSS 的 translate(-50%, -100%) 做不到這兩件事，最右欄的提示會有一半
   * 在畫面外，而 fixed 不會被捲動救回來。
   */
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const { width, height } = tip.getBoundingClientRect();
    const half = width / 2;
    const maxLeft = Math.max(MARGIN + half, window.innerWidth - MARGIN - half);
    const above = anchor.top - GAP - height;
    setPlacement({
      left: Math.min(Math.max(anchor.centerX, MARGIN + half), maxLeft),
      top: above >= MARGIN ? above : anchor.bottom + GAP,
    });
  }, [anchor]);

  /*
   * 座標是進場時算的，捲動之後就跟錨點脫節了；而且指標還停在同一個元素上，
   * 不會觸發 mouseleave。長列表是表格自己捲（.page.fills），所以要用 capture
   * 才聽得到內層容器的捲動。
   */
  useEffect(() => {
    if (!anchor) return;
    function close(event: Event) {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      hide();
    }
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", close);
    };
  }, [anchor]);

  return (
    <span
      className={`tooltip-anchor ${className}`.trim()}
      tabIndex={0}
      aria-describedby={anchor ? id : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {anchor ? (
        <span
          ref={tipRef}
          className="tooltip"
          role="tooltip"
          id={id}
          style={placement
            ? { left: placement.left, top: placement.top }
            // 還沒量到尺寸前先藏起來，不然會先在左上角閃一下。
            : { left: 0, top: 0, visibility: "hidden" }}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
