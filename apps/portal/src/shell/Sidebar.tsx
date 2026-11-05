import type { Permission } from "@rueisiang/auth/permissions";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { GuardedNavLink } from "./UnsavedChanges.js";
import type { SessionUser } from "../auth/session.js";
import { AccountPanel } from "./AccountPanel.js";
import { SystemSwitcher } from "./SystemSwitcher.js";
import { Icon } from "./icons.js";
import {
  NAV_SECTIONS,
  containsPath,
  sectionContainsPath,
  type NavItem,
  type NavSection,
} from "./nav.js";

interface SidebarProps {
  permissions: ReadonlySet<Permission>;
  collapsed: boolean;
  mobileOpen: boolean;
  onToggle: () => void;
  user: SessionUser | null;
  onLogout: () => void;
  onNavigate: () => void;
}

/*
 * 導覽列的形狀比照 Material 3 的 navigation drawer：
 *   - 每一列都是全圓角的膠囊，圖示 24px、不加外框
 *   - 選中的項目用「色調容器」（淡底＋深字），不是高彩度的填滿——
 *     Material 的作法是讓選中狀態安靜地成立，而不是跳出來搶視線
 *   - hover 是一層薄薄的 state layer，不是換一個顏色
 * 階層靠三件事表達：大項有 chevron、子項往內縮、以及兩者之間的分隔線。
 *
 * 收合成圖示欄只在桌機有意義；手機的 sidebar 是抽屜，靠位移開合。
 * 所以收合的樣式一律掛在 min-[901px]: 底下，手機自然回到展開的樣子。
 */
const ROW = "w-full items-center rounded-full border-0 text-left whitespace-nowrap transition-[background-color,color] duration-150 ease-out motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-secondary";
// 只剩圖示就不需要那麼高的點擊區，壓縮一點讓整份選單在筆電上不用捲。
const COLLAPSED_ROW = "min-[901px]:min-h-10 min-[901px]:grid-cols-[24px] min-[901px]:justify-center min-[901px]:gap-0 min-[901px]:p-0";
const LABEL = "overflow-hidden text-ellipsis";

/** 沒有權限的項目直接不畫出來；父項的子項也要一起過濾。陣列是「任一個」。 */
function visibleItems(items: NavItem[], permissions: ReadonlySet<Permission>): NavItem[] {
  return items
    .filter((item) => (Array.isArray(item.permission) ? item.permission : [item.permission])
      .some((permission) => permissions.has(permission)))
    .map((item) => ({ ...item, children: visibleItems(item.children ?? [], permissions) }));
}

function Item({ item, nested, collapsed, onNavigate }: { item: NavItem; nested: boolean; collapsed: boolean; onNavigate: () => void }) {
  const location = useLocation();
  const children = item.children ?? [];
  const active = containsPath(item, location.pathname);
  // 子項只在父項那一段路徑底下時才展開，不必讓人自己點開。
  const expanded = children.length > 0 && active;
  // 子頁面再往內縮一階、圖示縮小一號；收合後只剩圖示，就跟大項一樣大。
  const size = nested
    ? `min-h-10 grid-cols-[20px_minmax(0,1fr)] gap-3 text-[13.5px] ${collapsed ? "min-[901px]:grid-cols-[24px]" : ""}`
    : "min-h-11 grid-cols-[24px_minmax(0,1fr)] gap-3.5 text-[14px]";
  const tone = active
    ? "bg-brand-soft font-bold text-brand-dark hover:bg-[#f8ddd8]"
    : "bg-transparent text-[#6f5a58] hover:bg-brand/7 hover:text-brand-dark";
  const iconSize = nested ? `size-5 ${collapsed ? "min-[901px]:size-6" : ""}` : "size-6";

  return (
    <div>
      <GuardedNavLink
        to={item.to}
        end
        onClick={onNavigate}
        className={`group/item grid overflow-hidden px-3.5 no-underline ${ROW} ${size} ${tone}${collapsed ? ` min-[901px]:justify-items-center ${COLLAPSED_ROW}` : ""}`}
        title={item.label}
      >
        <Icon name={item.icon} className={`flex-none ${iconSize} ${active ? "text-brand" : "text-[#9a807c] group-hover/item:text-brand"}`} />
        <span className={`${LABEL}${collapsed ? " min-[901px]:hidden" : ""}`}>{item.label}</span>
      </GuardedNavLink>

      {expanded ? (
        <div className={`my-0.5 ml-3.5 grid gap-0.5 ${collapsed ? "min-[901px]:ml-0" : ""}`}>
          {children.map((child) => (
            <Item key={child.to} item={child} nested collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 大項那一列：可以是展開子項的按鈕，也可以是只有一個項目時直接連過去的連結。 */
function headClass(current: boolean, collapsed: boolean) {
  return `group/head grid min-h-12 grid-cols-[24px_minmax(0,1fr)_auto] gap-3.5 bg-transparent px-3.5 hover:bg-brand/7 hover:text-brand-dark ${ROW} ${current ? "text-brand-dark" : "text-[#5f4a48]"}${collapsed ? ` ${COLLAPSED_ROW}` : ""}`;
}

function HeadContent({ section, current, collapsed, children }: { section: NavSection; current: boolean; collapsed: boolean; children?: ReactNode }) {
  return (
    <>
      <Icon name={section.icon} className={`size-6 flex-none ${current ? "text-brand" : "text-[#9a807c] group-hover/head:text-brand"}`} />
      <span className={`${LABEL}${collapsed ? " min-[901px]:hidden" : ""}`}>{section.label}</span>
      {children}
    </>
  );
}

function Section({
  section,
  permissions,
  open,
  collapsed,
  onToggle,
  onNavigate,
}: {
  section: NavSection;
  permissions: ReadonlySet<Permission>;
  open: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  const location = useLocation();
  const items = visibleItems(section.items, permissions);
  if (!items.length) return null;

  if (items.length === 1 && section.homePath) {
    const item = items[0]!;
    const active = sectionContainsPath(section, location.pathname);
    return (
      <div>
        <GuardedNavLink
          to={item.to}
          end
          onClick={onNavigate}
          className={`no-underline ${headClass(active, collapsed)}`}
          title={section.label}
        >
          <HeadContent section={section} current={active} collapsed={collapsed} />
        </GuardedNavLink>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        className={headClass(open, collapsed)}
        aria-expanded={open}
        onClick={onToggle}
        title={section.label}
      >
        <HeadContent section={section} current={open} collapsed={collapsed}>
          <span
            className={`mr-0.5 size-[7px] border-r-2 border-b-2 border-current text-[#b39b97] transition-[transform] duration-200 ease-out motion-reduce:transition-none ${open ? "[transform:translateY(-2px)_rotate(45deg)]" : "[transform:translateY(-2px)_rotate(-45deg)]"}${collapsed ? " min-[901px]:hidden" : ""}`}
            aria-hidden="true"
          />
        </HeadContent>
      </button>

      {/*
        展開的動畫用 grid-template-rows 0fr → 1fr。
        max-height 那種要先猜一個高度，猜太小會截斷、猜太大會讓動畫看起來拖很久；
        grid 這招不必知道內容多高，而且 0fr 時完全不佔空間。
      */}
      <div
        className={`grid transition-[grid-template-rows,margin] duration-220 ease-out motion-reduce:transition-none ${open ? `mt-0.5 mb-1 grid-rows-[1fr] ${collapsed ? "min-[901px]:mb-0" : ""}` : "grid-rows-[0fr]"}`}
        aria-hidden={!open}
      >
        <div className={`grid gap-0.5 overflow-hidden pl-3.5 ${collapsed ? "min-[901px]:pl-0" : ""}`}>
          {items.map((item) => (
            <Item key={item.to} item={item} nested={false} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function Sidebar({ permissions, collapsed, mobileOpen, onToggle, user, onLogout, onNavigate }: SidebarProps) {
  const navRef = useRef<HTMLElement>(null);
  const location = useLocation();
  const [hasMoreBelow, setHasMoreBelow] = useState(false);

  /*
   * 一次只開一段。四段全開的話清單會長到要捲，反而更難找——手風琴式的展開
   * 讓「現在在哪一段」永遠只有一個答案。
   */
  const [openKey, setOpenKey] = useState<string | null>(
    () => NAV_SECTIONS.find((section) => sectionContainsPath(section, location.pathname))?.key ?? null,
  );

  // 從別的地方跳進某一段（網址列直接打、或選單外的連結）時要自動切過去。
  useEffect(() => {
    const active = NAV_SECTIONS.find((section) => sectionContainsPath(section, location.pathname));
    if (active) setOpenKey(active.key);
  }, [location.pathname]);

  /**
   * 收合成圖示欄時捲軸是藏起來的（見下面 nav 的 className），所以要自己給一個「下面還有」的提示。
   * 展開時看得到捲軸，這個箭頭就不出現。
   */
  const measure = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    setHasMoreBelow(nav.scrollHeight - nav.scrollTop - nav.clientHeight > 4);
  }, []);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    measure();
    nav.addEventListener("scroll", measure, { passive: true });
    // 展開／收合大項會改變高度，視窗縮放也會，兩者都要重新量。
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    for (const child of Array.from(nav.children)) observer.observe(child);

    return () => {
      nav.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure, collapsed]);

  /*
   * 手機：從左側滑出的抽屜，平常收著不佔版面。打開時要疊在上方列（z-30）之上，
   * 否則抽屜自己的品牌列會被蓋掉半截；抽屜只有 264px 寬，右邊的漢堡鈕露在外面，仍然點得到（用來關閉）。
   */
  const drawer = mobileOpen
    ? "max-[900px]:z-31 max-[900px]:translate-x-0 max-[900px]:[box-shadow:0_0_60px_rgba(64,30,30,.28)]"
    : "max-[900px]:-translate-x-full";

  return (
    <aside
      className={`sticky top-0 z-20 flex h-full min-h-0 flex-col border-r border-line bg-drawer px-4 pt-6 pb-[18px] max-[900px]:fixed max-[900px]:inset-y-0 max-[900px]:left-0 max-[900px]:w-[264px] max-[900px]:transition-[translate] max-[900px]:duration-220 max-[900px]:ease-out max-[900px]:motion-reduce:transition-none ${drawer}${collapsed ? " min-[901px]:px-2" : ""}`}
      id="portal-sidebar"
    >
      {/* 品牌列：展開時是完整字標，收合時換成只有圖記的方章。字標置中才能放大到接近欄寬——靠左時放大會撞到收合鈕。 */}
      <div className="flex h-[60px] items-center justify-center gap-2 overflow-hidden px-[5px] whitespace-nowrap">
        {/* 原圖 400×100（4:1），184px 寬＝46px 高，左右各留約 12px 呼吸空間。 */}
        <img className={`h-auto w-[184px] flex-[0_1_auto] object-contain ${collapsed ? "min-[901px]:hidden" : ""}`} src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" width={184} height={46} />
        <img className={`hidden size-[34px] object-contain ${collapsed ? "min-[901px]:block" : ""}`} src="/ruei-siang-icon.png" alt="RUEI SIANG" width={34} height={34} />
      </div>

      <button
        type="button"
        className="absolute top-7 -right-[17px] flex size-[34px] items-center justify-center rounded-[50%] border border-line bg-paper p-0 text-brand [box-shadow:0_5px_16px_rgba(80,35,35,.12)] max-[900px]:hidden"
        onClick={onToggle}
        aria-label={collapsed ? "展開側邊選單" : "收合側邊選單"}
        aria-expanded={!collapsed}
      >
        <span className={`size-2 border-t-2 border-r-2 border-current ${collapsed ? "[transform:translateX(-2px)_rotate(45deg)]" : "[transform:translateX(2px)_rotate(-135deg)]"}`} />
      </button>

      {/* nav 與「還有更多」的箭頭疊在同一個容器裡，箭頭才能貼著底部浮著。 */}
      <div className="relative mt-[22px] flex min-h-0 flex-1">
        {/*
          both-edges：捲軸出現時兩側都留一樣的空間，收合成圖示欄時才不會被推得偏一邊。
          收合時把捲軸藏起來——那條灰槓橫在 40px 寬的欄位裡太搶戲，還會把圖示擠偏。
        */}
        <nav
          className={`min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-color:var(--color-line)_transparent] [scrollbar-gutter:stable_both-edges] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-[3px] [&::-webkit-scrollbar-thumb]:bg-line [&::-webkit-scrollbar-thumb:hover]:bg-secondary [&>*+*]:mt-1.5 [&>*+*]:border-t [&>*+*]:border-soft-line [&>*+*]:pt-1.5 ${collapsed ? "min-[901px]:[scrollbar-width:none] min-[901px]:[&::-webkit-scrollbar]:hidden" : ""}`}
          aria-label="主要導覽"
          ref={navRef}
        >
          {NAV_SECTIONS.map((section) => (
            <Section
              key={section.key}
              section={section}
              permissions={permissions}
              open={openKey === section.key}
              collapsed={collapsed}
              onToggle={() => setOpenKey((current) => (current === section.key ? null : section.key))}
              onNavigate={onNavigate}
            />
          ))}
        </nav>

        {/* 捲軸藏起來之後改用底部的箭頭提示「下面還有」；漸層把最底下那一列淡出，暗示內容是被切掉而不是結束了。 */}
        {collapsed && hasMoreBelow ? (
          <button
            type="button"
            className="group/hint absolute inset-x-0 bottom-0 hidden h-[34px] items-end justify-center border-0 pb-1 [background:linear-gradient(to_bottom,transparent,var(--color-drawer)_62%)] min-[901px]:flex"
            aria-label="往下捲動看更多項目"
            onClick={() => navRef.current?.scrollBy({ top: 160, behavior: "smooth" })}
          >
            <span className="size-2 border-r-2 border-b-2 border-secondary [transform:translateY(-2px)_rotate(45deg)] transition-[transform,border-color] duration-150 ease-out motion-reduce:transition-none group-hover/hint:border-brand group-hover/hint:[transform:translateY(1px)_rotate(45deg)]" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="mt-auto flex-none border-t border-soft-line pt-2.5">
        <SystemSwitcher permissions={permissions} collapsed={collapsed} onNavigate={onNavigate} />
        <AccountPanel user={user} collapsed={collapsed} onLogout={onLogout} onNavigate={onNavigate} />
      </div>
    </aside>
  );
}
