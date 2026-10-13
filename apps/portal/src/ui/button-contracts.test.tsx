import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { Button, ButtonLink, ButtonSkin, Chip, ChipGroup } from "./index.js";

// 取出第一個元素的 class 清單；斷言只認「這個語意該帶的關鍵 class」，不綁整串字串。
function classes(element: ReactElement): string[] {
  const markup = renderToStaticMarkup(element);
  return (markup.match(/class="([^"]*)"/)?.[1] ?? "").replaceAll("&amp;", "&").split(/\s+/);
}

describe("Button 的外觀契約", () => {
  it("tone 決定語意色，variant 決定是填滿還是外框", () => {
    expect(classes(<Button>送出</Button>)).toContain("bg-brand");
    expect(classes(<Button tone="success">新增</Button>)).toContain("bg-ok");
    expect(classes(<Button variant="secondary" tone="info">編輯</Button>)).toEqual(expect.arrayContaining(["border-info", "bg-info-soft", "text-info"]));
    expect(classes(<Button variant="secondary" tone="danger">停用</Button>)).toContain("text-brand-dark");
    expect(classes(<Button variant="danger">刪除</Button>)).toContain("bg-brand-dark");
  });

  it("size 與 active 是 prop，不靠外部 class", () => {
    expect(classes(<Button size="lg">送出</Button>)).toContain("min-h-11");
    expect(classes(<Button>送出</Button>)).not.toContain("min-h-11");
    expect(classes(<Button variant="secondary" active>篩選</Button>)).toEqual(expect.arrayContaining(["bg-brand-soft", "text-brand-dark"]));
  });

  it("mobileIconOnly 把文字包起來，手機寬度才藏得掉", () => {
    const markup = renderToStaticMarkup(<Button icon="plus" mobileIconOnly aria-label="新增客人">新增客人</Button>);
    expect(markup).toContain('<span class="max-[760px]:hidden">新增客人</span>');
    expect(markup).toContain("max-[760px]:size-11");
  });

  it("glass 皮膚的預設主按鈕是藍色玻璃，不是品牌紅", () => {
    const glass = classes(<ButtonSkin skin="glass"><Button>儲存</Button></ButtonSkin>);
    expect(glass).toContain("bg-info/74");
    expect(glass).toContain("[backdrop-filter:blur(6px)_saturate(145%)]");
    expect(glass).not.toContain("bg-brand");
  });

  it("paper／floating 只把透明底換成紙色，有語意色的底不動", () => {
    expect(classes(<Button variant="secondary">複製</Button>)).toContain("bg-transparent");
    const paper = classes(<ButtonSkin skin="paper"><Button variant="secondary">複製</Button></ButtonSkin>);
    expect(paper).toContain("bg-paper");
    expect(paper).not.toContain("bg-transparent");
    expect(classes(<ButtonSkin skin="paper"><Button variant="secondary" tone="info">編輯</Button></ButtonSkin>)).toContain("bg-info-soft");
    const floating = classes(<ButtonSkin skin="floating"><Button variant="icon" icon="plus" aria-label="放大" /></ButtonSkin>);
    expect(floating).toEqual(expect.arrayContaining(["bg-paper", "[box-shadow:var(--shadow-panel)]"]));
  });

  it("hover 一律用 not-disabled:——enabled: 對 <a> 永遠不成立，連結會失去 hover", () => {
    for (const element of [
      <Button>送出</Button>,
      <Button variant="secondary" tone="success">新增</Button>,
      <Button variant="icon" icon="plus" tone="danger" aria-label="刪除" />,
      <ButtonSkin skin="glass"><Button variant="secondary">取消</Button></ButtonSkin>,
    ]) {
      const list = classes(element);
      expect(list.some((name) => name.startsWith("not-disabled:hover:"))).toBe(true);
      expect(list.some((name) => name.startsWith("enabled:hover:"))).toBe(false);
    }
  });
});

describe("ButtonLink", () => {
  it("輸出 <a>，外觀跟 Button 同一份，而且沒有任何 enabled: 條件", () => {
    const markup = renderToStaticMarkup(<ButtonLink href="/tools/payout" icon="payments">前往執行出金表</ButtonLink>);
    expect(markup.startsWith('<a href="/tools/payout"')).toBe(true);
    const list = classes(<ButtonLink href="/tools/payout" icon="payments">前往執行出金表</ButtonLink>);
    expect(list).toEqual(expect.arrayContaining(["bg-brand", "not-disabled:hover:bg-brand-dark", "no-underline"]));
    expect(list.some((name) => name.startsWith("enabled:"))).toBe(false);
  });
});

describe("Chip", () => {
  it("filter 的選取狀態同時反映在外觀與 aria-pressed", () => {
    const selected = renderToStaticMarkup(<Chip selected>依售額</Chip>);
    expect(selected).toContain('aria-pressed="true"');
    expect(classes(<Chip selected>依售額</Chip>)).toEqual(expect.arrayContaining(["bg-brand-soft", "text-brand-dark"]));
    expect(renderToStaticMarkup(<Chip>依淨銷量</Chip>)).toContain('aria-pressed="false"');
    expect(classes(<Chip>依淨銷量</Chip>)).toContain("bg-paper");
  });

  it("action 是虛線框，不帶 aria-pressed；success 是新增的語意色", () => {
    const markup = renderToStaticMarkup(<Chip variant="action" icon="plus">新增通路</Chip>);
    expect(markup).not.toContain("aria-pressed");
    expect(classes(<Chip variant="action">新增通路</Chip>)).toContain("border-dashed");
    expect(classes(<Chip variant="action" tone="success">新增通路</Chip>)).toEqual(expect.arrayContaining(["bg-ok/12", "text-ok"]));
  });

  it("分段膠囊：外框與刪除鈕都跟著選取狀態換色", () => {
    expect(classes(<ChipGroup selected><Chip variant="label" selected>VIP</Chip></ChipGroup>)).toContain("bg-brand-soft");
    expect(classes(<Chip variant="remove" selected aria-label="刪除視圖" />)).toContain("text-brand-dark");
    expect(classes(<Chip variant="remove" aria-label="刪除視圖" />)).toContain("text-muted");
  });
});
