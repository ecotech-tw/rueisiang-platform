// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog } from "./index.js";

let root: Root | null = null;
let host: HTMLElement | null = null;

async function openDialogInside(scopeClassName: string) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  host.className = scopeClassName;
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Dialog title="審核加班申請" onClose={() => {}} actions={<button type="button">核准</button>}>內容</Dialog>));
  return document.body.querySelector(".modal-scope");
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/**
 * 對話框 portal 到 body 之後會離開站的樣式範圍，語意色（核准的綠、修改的藍）全部失效，
 * 核准會落回品牌紅、跟駁回分不出來。這裡守的是「範圍有被補回來」。
 */
describe("Dialog 補回站的樣式範圍", () => {
  it("員工 HR 站的對話框帶回 hr-module-self，而且殼不在原本的範圍裡面", async () => {
    const scope = await openDialogInside("hr-module hr-module-self");
    expect(scope?.className).toBe("modal-scope hr-module-self");
    expect(host!.contains(scope)).toBe(false);
    expect(scope?.querySelector(".modal-actions button")?.textContent).toBe("核准");
  });

  it("管理介面的對話框帶回 hr-system", async () => {
    expect((await openDialogInside("hr-module hr-system"))?.className).toBe("modal-scope hr-system");
  });

  it("不在任何 HR 範圍時不多帶 class", async () => {
    expect((await openDialogInside("page"))?.className).toBe("modal-scope");
  });
});
