import { createContext, useContext, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { defaultUnless } from "./class-defaults.js";

export type PageSpacingName = "default" | "compact-mobile";

const PageSpacingContext = createContext<PageSpacingName>("default");

/** 頁面區塊之間的距離，由 app 決定：HR 員工 app 在手機上排得比較密。 */
export function PageSpacing({ spacing, children }: { spacing: PageSpacingName; children: ReactNode }) {
  return <PageSpacingContext value={spacing}>{children}</PageSpacingContext>;
}

/*
 * 區塊之間的距離寫在頁面上（> * + *），不靠各元件記得加 margin：只要在兩個 Panel 之間插進別種
 * 元素（Alert、收合區塊），「各自加 margin」的寫法就會兩邊同時消失，畫面上只看得到黏在一起。
 *
 * 整段選擇器包在 :where() 裡，權重是 0：區塊自己寫的 mt-4、或頁面 className 的 `[&>.某塊]:mt-2`
 * 都一定蓋得過，不必靠 Tailwind 的產生順序。
 */
const STACK_GAP: Record<PageSpacingName, string> = {
  default: "[:where(&>*+*)]:mt-5",
  "compact-mobile": "[:where(&>*+*)]:mt-5 max-[760px]:[:where(&>*+*)]:mt-3.5",
};

export type PageLayout = "flow" | "fills" | "bleed";

interface PageProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "children"> {
  /**
   * - flow：一般頁面，整頁跟著外層一起捲。
   * - fills：撐滿內容區、整頁不捲，只有 grows 的那個 Panel 自己捲（長列表）。
   * - bleed：撐滿內容區、不留外框內距（地圖這種整片畫布）。
   */
  layout?: PageLayout;
  ref?: Ref<HTMLDivElement>;
  /** 頁面自己的 class 與版面。fills 給了 gap- 就整組取代預設的 gap-5。 */
  className?: string;
  children: ReactNode;
}

/** 每個 route 最外層的容器。data-page 讓外層殼認得出 fills／bleed，決定自己要不要捲。 */
export function Page({ layout = "flow", className = "", children, ...rest }: PageProps) {
  const spacing = useContext(PageSpacingContext);
  const classes = {
    flow: `min-w-0 ${STACK_GAP[spacing]}`,
    // fills 用 gap 排，區塊之間的上外距歸零（一樣是權重 0），不然會跟 gap 疊在一起。
    // 例外是面板接面板：舊版兩條規則疊起來是 gap 加 20px 外距，畫面一直是這樣，先照舊保留。
    fills: `flex h-full min-h-0 min-w-0 flex-col ${defaultUnless(className, "gap-", "gap-5")} [:where(&>*+*)]:mt-0 [:where(&>[data-panel])+[data-panel]]:mt-5 [&>.page-head]:flex-none [&>.stat-row]:mb-0 [&>.stat-row]:flex-none [&>details]:flex-none`,
    bleed: `relative h-full min-w-0 ${STACK_GAP[spacing]}`,
  }[layout];
  return <div {...rest} data-page={layout} className={`${classes} ${className}`.trim()}>{children}</div>;
}
