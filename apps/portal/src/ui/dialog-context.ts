import { createContext } from "react";

export interface DialogContextValue {
  onClose?: () => void;
  requestClose: () => void;
}

export const DialogContext = createContext<DialogContextValue | null>(null);
