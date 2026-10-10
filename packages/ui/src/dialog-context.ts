import { createContext } from "react";

export type DialogCloseRequest = (afterClose?: () => void) => void;
export type DialogCloseRef = { current: DialogCloseRequest | null };

export interface DialogContextValue {
  onClose?: () => void;
  requestClose: () => void;
}

export const DialogContext = createContext<DialogContextValue | null>(null);

/**
 * 對話框 portal 到 body 之後要補回的樣式範圍 class（例如 hr-system）。由站台在版面根節點提供，
 * 共用元件不需要知道有哪些站、各自叫什麼。React context 會穿過 portal，所以值跟的是
 * 「開對話框的元件在哪個範圍裡」，不是「畫面上剛好有沒有那個 class」。
 */
export const DialogScopeContext = createContext("");
