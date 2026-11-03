import { createContext, useContext, type ReactNode } from "react";

export type InputSkinName = "solid" | "glass";

const InputSkinContext = createContext<InputSkinName>("solid");

/**
 * 輸入框與下拉的整體風格，跟 ButtonSkin 一樣由外層決定，不靠祖先 class 從外面蓋。
 * - solid：預設的實心底。
 * - glass：HRIS 管理介面的半透明玻璃；只套在日期類欄位、下拉按鈕與彈出選單，文字欄位維持實心才讀得清楚。
 */
export function InputSkin({ skin, children }: { skin: InputSkinName; children: ReactNode }) {
  return <InputSkinContext value={skin}>{children}</InputSkinContext>;
}

export function useInputSkin(): InputSkinName {
  return useContext(InputSkinContext);
}

/**
 * 玻璃欄位的表面：日期輸入框與下拉按鈕共用，兩者才會是同一塊玻璃。
 * 停用時仍是玻璃底，只把字變淡：灰底疊在半透明上會變成一塊髒污。
 */
export const GLASS_FIELD = "border-transparent bg-paper/38 [box-shadow:var(--shadow-glass-field)] [-webkit-backdrop-filter:blur(8px)_saturate(155%)_contrast(103%)] [backdrop-filter:blur(8px)_saturate(155%)_contrast(103%)] transition-[background-color,box-shadow,border-color] duration-150 ease-out hover:bg-paper/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary";
