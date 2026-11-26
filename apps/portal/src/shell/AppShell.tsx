import { useLayoutEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { logout, useSession } from "../auth/session.js";
import { isSystemPath, settleSystemTransition } from "./system-transition.js";
import { Sidebar } from "./Sidebar.js";
import { MobilePageTitle, PageDescriptions } from "../ui/index.js";
import { GlassSkins } from "./GlassSkins.js";
import { GLASS_BRAND_CHIP, GlassDefs, glassCircleButtonClass } from "./glass.js";
import { Icon } from "./icons.js";
import { PageTitleContext } from "./usePageTitle.js";
import { ToastProvider } from "./Toast.js";

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [pageTitle, setPageTitle] = useState<string>();
  const { user, permissions } = useSession();
  const isSystemModule = isSystemPath(useLocation().pathname);

  // 新畫面已經進 DOM、還沒上色：這時放行 View Transition 拍「新狀態」才拍得到。
  useLayoutEffect(() => settleSystemTransition(isSystemModule), [isSystemModule]);

  // 左欄寬度：HRIS、會計這類系統沒有 sidebar（自己有一套導覽），收合時只剩圖示欄。手機一律單欄；非 HRIS 上面另有一條 topbar。
  const columns = isSystemModule ? "grid-cols-[minmax(0,1fr)]" : collapsed ? "grid-cols-[76px_minmax(0,1fr)]" : "grid-cols-[252px_minmax(0,1fr)]";
  // 手機上方列只有非 HRIS 才有；HRIS 也切兩列的話，唯一的 main 會掉進 auto 那列，只撐到內容高，底下露出一塊空白。
  const rows = isSystemModule ? "grid-rows-[minmax(0,1fr)]" : "max-[900px]:grid-rows-[auto_minmax(0,1fr)]";
  /*
   * 內容區自己捲，整頁不捲（html/body 看 data-shell 鎖住）。
   * fills 的頁面只讓表格捲、bleed 的頁面（地圖）連內距都不要；小香測試台自己分兩欄各自捲。
   */
  const content = isSystemModule
    ? "p-0"
    : "px-9 py-8 max-[900px]:px-4 max-[900px]:py-5 max-[760px]:[--page-gutter:16px] max-[760px]:[--page-pad-top:20px] max-[760px]:[--page-pad-bottom:20px] max-[760px]:has-[[data-grows]_[data-pager]]:pb-0 max-[760px]:has-[[data-grows]_[data-pager]]:[--page-pad-bottom:0px]";

  return (
    <ToastProvider>
    <PageTitleContext value={setPageTitle}>
    {/*
      * 玻璃要透得出東西：外框底下鋪一層淡淡的品牌色漸層，側欄、上方列與內容區都疊在它上面。
      * 手機用 dvh：iOS Safari 的 100vh 把底部工具列底下那段也算進去，外框又鎖住不捲，
      * 最底下的分頁列會被工具列蓋住而且捲不到。員工 HR 站的外框也是這樣寫。
      */}
    <div data-shell="" className={`grid h-screen [background:radial-gradient(circle_at_top_left,--alpha(var(--color-brand)/8%),transparent_34rem),var(--color-canvas)] min-h-screen overflow-hidden max-[760px]:h-dvh max-[760px]:min-h-dvh ${columns} transition-[grid-template-columns] duration-220 ease-out motion-reduce:transition-none max-[900px]:grid-cols-1 ${rows}`}>
      {!isSystemModule ? <>
        <GlassDefs />
        {/*
          * 手機上 sidebar 收成抽屜，靠這條上方列開關。長得跟 HRIS 的頁首一樣：品牌膠囊＋圓形選單鈕。
          * 760 以下頁面不顯示 h1（下面的 MobilePageTitle），頁名改寫在膠囊裡；760–900 的平板 h1 還在，膠囊只放 logo。
          */}
        <header className="sticky top-0 z-30 hidden grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 px-4 pt-3 pb-3.5 max-[900px]:grid">
          <div className={`${GLASS_BRAND_CHIP} justify-self-start`}>
            <img className="h-auto w-[92px] flex-none object-contain" src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" width={150} height={38} />
            {pageTitle ? <strong className="hidden min-w-0 truncate border-l border-l-ink/6 pl-3 text-[15px] font-black text-ink max-[760px]:block">{pageTitle}</strong> : null}
          </div>
          <button
            type="button"
            className={glassCircleButtonClass(mobileMenuOpen)}
            onClick={() => setMobileMenuOpen((open) => !open)}
            aria-expanded={mobileMenuOpen}
            aria-controls="portal-sidebar"
            aria-label={mobileMenuOpen ? "關閉選單" : "開啟選單"}
          >
            <Icon name={mobileMenuOpen ? "close" : "menu"} className="size-[22px] text-brand-dark" />
          </button>
        </header>

        <button
          type="button"
          className={`fixed inset-0 z-19 hidden border-0 bg-ink/38 ${mobileMenuOpen ? "max-[900px]:block" : ""}`}
          onClick={() => setMobileMenuOpen(false)}
          aria-label="關閉選單"
        />

        <Sidebar
          permissions={permissions}
          collapsed={collapsed}
          mobileOpen={mobileMenuOpen}
          onToggle={() => setCollapsed((value) => !value)}
          user={user}
          onLogout={() => void logout()}
          onNavigate={() => setMobileMenuOpen(false)}
        />
      </> : null}

      {/*
        * 「整頁不捲、只有表格自己捲」只在桌機成立。手機上表格變成卡片、沒有要釘住的表頭，
        * 篩選欄位又一欄一列往下排，鎖住高度會把表格區擠到 0；所以手機上 fills 頁面照內容長高、整頁捲。
        * 手機上整頁不准左右捲：要橫捲的東西（寬表格、膠囊列）都有自己的捲動容器，多出幾 px 的元素
        * 不該讓整頁被手指拖得左右晃（HrMain 同理）。
        */}
      <main className={`h-full min-h-0 min-w-0 overflow-y-auto max-[760px]:overflow-x-hidden ${content} min-[760px]:has-[[data-page=fills]]:overflow-y-hidden max-[760px]:[&_[data-page=fills]]:h-auto min-[760px]:has-[[data-sandbox-page]]:overflow-hidden has-[[data-page=bleed]]:overflow-hidden has-[[data-page=bleed]]:p-0`}>
        {/*
          * 頁首一律不顯示說明（跟 HRIS 一樣）：固定的介紹句每次進來都要讀過一遍，佔掉的高度比它帶來的資訊多。
          * 會跟著資料變、或使用者需要知道的資訊不能只放在說明裡，要寫在頁面上（例如品項庫存的補貨數）。
          */}
        <GlassSkins><PageDescriptions visible={false}><MobilePageTitle visible={!pageTitle}><Outlet /></MobilePageTitle></PageDescriptions></GlassSkins>
      </main>
    </div>
    </PageTitleContext>
    </ToastProvider>
  );
}
