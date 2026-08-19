import { useEffect } from "react";

/** 全站共用的前綴。分頁標題只有前面幾個字看得到，品牌要排在前面。 */
export const TITLE_PREFIX = "瑞香 Ruei Siang";

/**
 * 設定分頁標題。
 *
 * SPA 換頁不會動到 document.title，不設的話整站每一頁在瀏覽器分頁、書籤與
 * 上一頁清單裡都長一樣，開了幾頁就分不出誰是誰。
 *
 * 刻意不在離開時還原：下一頁自己會設，中間那一瞬間的閃動反而更難看。
 */
export function usePageTitle(title?: string): void {
  useEffect(() => {
    document.title = title ? `${TITLE_PREFIX} | ${title}` : TITLE_PREFIX;
  }, [title]);
}
