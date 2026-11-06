import { NavLink, useLocation } from "react-router";
import { Icon, type IconName } from "../shell/icons.js";

interface PageTab {
  label: string;
  to: string;
  icon?: IconName;
  /** 內頁仍屬於這個分頁時，保留該分頁的選取狀態。 */
  activePaths?: string[];
}

/*
 * 底槽要有顏色：頁面底色是 canvas，沒有底槽的話這一排跟頁面上其他文字連結長得一樣，實測會被整個略過。
 * flex-none 與 self-start 都不能省——放在 fills 頁面這種 flex 直欄裡時，前者沒有會被下面的內容擠成
 * 高度 0（DOM 還在，只有眼睛看不到），後者沒有會被拉成滿版。
 */
const TRACK = "inline-flex max-w-full flex-none items-center gap-1 self-start overflow-x-auto rounded-full bg-soft-line p-[5px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
const TAB = "inline-flex items-center gap-2 rounded-full px-[18px] py-[9px] text-[14px] whitespace-nowrap no-underline transition-[background-color,color,box-shadow] duration-120 ease-out motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary";
const TAB_IDLE = "font-semibold text-muted hover:bg-brand/4 hover:text-brand-dark";
const TAB_ACTIVE = "bg-paper font-bold text-brand-dark [box-shadow:0_1px_2px_--alpha(var(--color-ink)/8%),0_4px_10px_--alpha(var(--color-ink)/6%)]";

/**
 * 同一個功能底下平行子頁面的切換列。做成分段控制：一條內凹的底槽，選中的那一段
 * 浮起來變成一張白卡。
 *
 * **不在這裡讀權限。** 呼叫端自己先濾好再傳進來：哪個分頁要哪個權限是那一區的
 * 知識，塞進共用元件會讓它得認識每一個功能的權限鍵。
 *
 * 只剩一個分頁時照樣畫得出來——那一段仍然在說「你在這裡」，而且分頁數量會隨權限
 * 變動，為了少一段而讓版面忽有忽無反而更難讀。
 */
export function PageTabs({ tabs, label }: { tabs: PageTab[]; label: string }) {
  const pathname = useLocation().pathname;
  if (!tabs.length) return null;
  return (
    <nav className={TRACK} aria-label={label}>
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end
          className={({ isActive }) => `${TAB} ${isActive || tab.activePaths?.some((path) => pathname === path || pathname.startsWith(`${path}/`)) ? TAB_ACTIVE : TAB_IDLE}`}
        >
          {tab.icon ? <Icon name={tab.icon} className="size-5 flex-none" /> : null}
          <span>{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
