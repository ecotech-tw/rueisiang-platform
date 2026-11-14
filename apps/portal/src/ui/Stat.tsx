import type { ReactNode } from "react";

interface StatRowProps {
  /** 只給版面用（外距、grid 位置）；元件自己不帶外距。 */
  className?: string;
  "aria-label"?: string;
  children: ReactNode;
}

/**
 * 一排統計卡。窄螢幕排成兩欄，避免每張卡都佔滿整列。
 *
 * data-stat-row 是給 Page 認的：fills 版面要它維持自己的高度（flex: none），
 * 不跟 grows 的面板分高度。
 */
export function StatRow({ className = "", children, ...rest }: StatRowProps) {
  return (
    <div
      {...rest}
      data-stat-row
      className={`grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-3 max-[760px]:grid-cols-2 max-[760px]:gap-2 ${className}`.trim()}
    >
      {children}
    </div>
  );
}

const LABEL = "text-[12px] text-muted";
const VALUE = "text-[20px] max-[760px]:text-[17px]";

/** 一張統計卡：標籤＋數字。valueFirst 給數字比標籤重要、要先讀到的位置（倉位抽屜）。 */
export function Stat({ label, value, valueFirst = false }: { label: ReactNode; value: ReactNode; valueFirst?: boolean }) {
  return (
    <div className="grid gap-0.5 rounded-[14px] border border-line bg-paper px-3.5 py-3 max-[760px]:px-3 max-[760px]:py-2.5">
      {valueFirst ? <><strong className={VALUE}>{value}</strong><span className={LABEL}>{label}</span></> : <><span className={LABEL}>{label}</span><strong className={VALUE}>{value}</strong></>}
    </div>
  );
}
