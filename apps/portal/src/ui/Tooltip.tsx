import { useCallback, useId, useState, type ReactNode } from "react";

export interface TooltipProps {
  /** 提示內容。純文字；需要標題與段落的是 Material 的 rich tooltip，目前沒有需求。 */
  label: string;
  children: ReactNode;
  className?: string;
}

interface Anchor {
  left: number;
  top: number;
}

/**
 * Material 3 的 plain tooltip。
 *
 * 不用瀏覽器原生的 `title`：它有一秒多的延遲、字級與圓角都不歸我們管，
 * 而且在觸控裝置上根本不會出現。這裡 hover 或 focus 就立刻顯示。
 *
 * 位置用 `position: fixed` 加 getBoundingClientRect 算出來，不是相對定位——
 * KPI 卡與資料表都有 `overflow: hidden`，相對定位的提示會被裁掉。
 */
export function Tooltip({ label, children, className = "" }: TooltipProps) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const id = useId();

  const show = useCallback((event: { currentTarget: HTMLElement }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setAnchor({ left: rect.left + rect.width / 2, top: rect.top });
  }, []);
  const hide = useCallback(() => setAnchor(null), []);

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
        <span className="tooltip" role="tooltip" id={id} style={{ left: anchor.left, top: anchor.top }}>
          {label}
        </span>
      ) : null}
    </span>
  );
}
