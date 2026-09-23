import { createContext } from "react";

export type DialogCloseRequest = (afterClose?: () => void) => void;
export type DialogCloseRef = { current: DialogCloseRequest | null };

export interface DialogContextValue {
  onClose?: () => void;
  requestClose: () => void;
}

export const DialogContext = createContext<DialogContextValue | null>(null);
