// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogScope, Panel } from "./index.js";

let root: Root | null = null;
let host: HTMLElement | null = null;

const dialog = <Dialog title="審核加班申請" onClose={() => {}} actions={<button type="button">核准</button>}>內容</Dialog>;

async function render(tree: ReactNode, hostClassName = "page") {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  host.className = hostClassName;
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(tree));
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
 * 核准會落回品牌紅、跟駁回分不出來。這裡守的是「站台提供的範圍有被補回來」。
 */
describe("Panel 內距契約", () => {
  it("預設內距不變，compact 透過 prop 縮減內距而非從 route 蓋樣式", async () => {
    await render(<><Panel>預設</Panel><Panel density="compact">緊湊</Panel></>);
    const panels = [...host!.querySelectorAll(".panel")];
    expect(panels[0]!.classList.contains("p-2")).toBe(false);
    expect(panels[1]!.classList.contains("p-2")).toBe(true);
  });
});

describe("Dialog 補回站的樣式範圍", () => {
  it("在 DialogScope 裡開的對話框帶回站台給的 class，而且殼已經移到範圍外面", async () => {
    const scope = await render(<DialogScope className="hr-module-self">{dialog}</DialogScope>, "hr-module hr-module-self");
    expect(scope?.className).toBe("modal-scope hr-module-self");
    expect(host!.contains(scope)).toBe(false);
    expect(scope?.querySelector(".modal-actions button")?.textContent).toBe("核准");
  });

  it("範圍跟的是開對話框的元件，不是畫面上剛好有沒有那個 class", async () => {
    // 頁面上有 .hr-system，但對話框不是從那個範圍裡開的（例如掛在 shell 層的確認框）。
    expect((await render(dialog, "hr-module hr-system"))?.className).toBe("modal-scope");
  });

  it("內層的範圍蓋過外層；空字串等於不帶範圍", async () => {
    expect((await render(<DialogScope className="hr-system"><DialogScope className="">{dialog}</DialogScope></DialogScope>))?.className).toBe("modal-scope");
  });
});
