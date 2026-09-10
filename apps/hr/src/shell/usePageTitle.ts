import { useEffect } from "react";

 
export const TITLE_PREFIX = "瑞香 Ruei Siang";

 
export function usePageTitle(title?: string): void {
  useEffect(() => {
    document.title = title ? `${TITLE_PREFIX} | ${title}` : TITLE_PREFIX;
  }, [title]);
}
