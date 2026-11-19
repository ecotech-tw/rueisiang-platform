// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Button, Dialog, Panel } from "./index.js";
import { Icon } from "../shell/icons.js";
import { ButtonSkin } from "@rueisiang/ui";

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(tree: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(tree));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("Icon 線寬契約", () => {
  it("預設 consumer 不變，可明確配合 regular 與 semibold 字重", async () => {
    await render(<><Icon name="calendar" /><Icon name="calendar" weight="regular" /><Icon name="calendar" weight="semibold" /></>);
    expect([...host!.querySelectorAll("svg")].map((icon) => icon.getAttribute("stroke-width"))).toEqual(["1.8", "1.5", "2"]);
  });
});

describe("圖示按鈕觸控尺寸", () => {
  it("預設圖示維持 40px，lg 儲存圖示提供 44px 且只有一個尺寸 class", async () => {
    await render(<><Button variant="icon" icon="save" aria-label="預設儲存" /><Button variant="icon" size="lg" icon="save" aria-label="儲存排班" /><ButtonSkin skin="glass"><Button variant="icon" icon="save" aria-label="玻璃預設儲存" /><Button variant="icon" size="lg" icon="save" aria-label="玻璃儲存排班" /></ButtonSkin></>);
    const buttons = [...host!.querySelectorAll("button")];
    expect(buttons[0]!.classList.contains("size-10")).toBe(true);
    expect(buttons[1]!.classList.contains("size-11")).toBe(true);
    expect(buttons[1]!.classList.contains("size-10")).toBe(false);
    expect(buttons[1]!.querySelector("svg")).not.toBeNull();
    expect(buttons[2]!.classList.contains("size-10")).toBe(true);
    expect(buttons[3]!.classList.contains("size-11")).toBe(true);
    expect(buttons[3]!.classList.contains("size-10")).toBe(false);
    expect(buttons[3]!.classList.contains("bg-paper/22")).toBe(true);
    expect(buttons[3]!.classList.contains("bg-transparent")).toBe(false);
  });
});

describe("Panel 內距契約", () => {
  it("預設內距不變，compact 透過 prop 縮減內距而非從 route 蓋樣式", async () => {
    await render(<><Panel>預設</Panel><Panel density="compact">緊湊</Panel></>);
    const panels = [...host!.querySelectorAll("[data-panel]")];
    expect(panels[0]!.classList.contains("p-2")).toBe(false);
    expect(panels[1]!.classList.contains("p-2")).toBe(true);
  });
});

/**
 * 對話框 portal 到 body 之後就不在版面容器裡了。皮膚與語意色若靠祖先選擇器套上，核准會落回
 * 品牌紅、跟駁回分不出來；現在它們是 context 與 prop，這裡守的是「portal 出去仍然拿得到」。
 */
describe("Dialog portal 之後保留皮膚與語意色", () => {
  it("在玻璃皮膚裡開的對話框，掛在版面外面，按鈕仍是玻璃的成功色", async () => {
    await render(<ButtonSkin skin="glass"><Dialog title="審核加班申請" onClose={() => {}} actions={<Button tone="success">核准</Button>}>內容</Dialog></ButtonSkin>);
    const approve = [...document.body.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "核准");
    expect(approve).toBeDefined();
    expect(host!.contains(approve!)).toBe(false);
    expect(approve!.classList.contains("bg-ok/78")).toBe(true);
  });
});
