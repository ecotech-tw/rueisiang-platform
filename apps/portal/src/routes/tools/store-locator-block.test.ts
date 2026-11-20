// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const html = readFileSync(resolve(process.cwd(), "../../tools/cyberbiz-blocks/store-locator/block.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
const stores = [
  { id: "north", name: "北部櫃點", shortName: "北部櫃點", label: "臺北市｜北部櫃點", county: "臺北市", pinX: 750, pinY: 300 },
  { id: "south", name: "南部櫃點", shortName: "南部櫃點", label: "高雄市｜南部櫃點", county: "高雄市", pinX: 530, pinY: 800 },
  { id: "east", name: "右界櫃點", shortName: "右界櫃點", label: "宜蘭縣｜右界櫃點", county: "宜蘭縣", pinX: 840, pinY: 500 },
].map((store) => ({ ...store, category: "百貨公司", address: "測試地址", hours: "11:00–22:00", image: "", mapUrl: "https://www.google.com/maps/", region: "north" }));
let scrollTo: ReturnType<typeof vi.fn>;
let listeners: Array<{ target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }>;
const card = () => document.querySelector("#rs-desktop-card-container")!.firstElementChild;
const wheel = () => document.querySelector<HTMLElement>("#rs-desktop-wheel")!;
const pin = (id: string) => document.querySelector<SVGElement>(`[data-pin-id="${id}"]`)!;
function click(element: Element) { element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); }

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ stores })));
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  listeners = [];
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
      if (listener) listeners.push({ target, type, listener, options });
      add(type, listener, options);
    });
  }
  document.body.innerHTML = html.replace(/<script>[\s\S]*?<\/script>/, "");
  scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = options.top ?? 0;
    this.dispatchEvent(new Event("scroll"));
  });
  Object.defineProperty(wheel(), "scrollTo", { value: scrollTo, configurable: true });
  new Function(script)();
  await vi.advanceTimersByTimeAsync(0);
});
afterEach(() => {
  for (const { target, type, listener, options } of listeners) target.removeEventListener(type, listener, options);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.innerHTML = ""; document.body.style.overflow = "";
});

it("圖釘以尖端為錨點，整層只向右平移一次，不改 API 原始座標", () => {
  expect(document.querySelector("#map-pins")!.getAttribute("transform")).toBe("translate(30, 0)");
  expect(pin("south").getAttribute("transform")).toBe("translate(530, 800)");
  expect(pin("south").querySelector(".rs-pin-body")!.getAttribute("d")).toMatch(/^M 0,0 /);
});

it("合法右界 X=840 校正後仍在 viewBox 內，並保留圖釘與點擊區域的留白", () => {
  const svg = document.querySelector("#rs-taiwan-map")!;
  const [x, , width] = svg.getAttribute("viewBox")!.split(" ").map(Number);
  expect(x! + width!).toBeGreaterThanOrEqual(840 + 30 + 20);
  expect(pin("east").getAttribute("transform")).toBe("translate(840, 500)");
  click(pin("east"));
  expect(pin("east").classList.contains("is-selected")).toBe(true);
  expect(card()?.textContent).toContain("右界櫃點");
});

it.each([320, 375, 768, 1280])("視窗寬度 %s 時 SVG 限制在容器寬度內，切換版型不移除限制", (width) => {
  vi.stubGlobal("innerWidth", width);
  window.dispatchEvent(new Event("resize"));
  const svg = document.querySelector("#rs-taiwan-map")!;
  expect(svg.classList.contains("min-w-0")).toBe(true);
  expect(svg.classList.contains("max-w-none")).toBe(false);
  expect(svg.classList.contains(width < 1024 ? "max-w-full" : "max-w-[540px]")).toBe(true);
  expect(svg.parentElement?.id).toBe(width < 1024 ? "rs-mobile-map-host" : "rs-desktop-map-host");
  const [x, , viewWidth] = svg.getAttribute("viewBox")!.split(" ").map(Number);
  expect(x! + viewWidth!).toBeGreaterThanOrEqual(890);
});

it("點圖釘即時同步列表，不受 CSS smooth 影響；延後 scroll snap 不重建相同卡片", async () => {
  click(pin("south"));
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 52, behavior: "instant" });
  const selectedCard = card();
  expect(selectedCard?.textContent).toContain("南部櫃點");
  await vi.advanceTimersByTimeAsync(70);
  wheel().dispatchEvent(new Event("scroll"));
  await vi.advanceTimersByTimeAsync(700);
  expect(card()).toBe(selectedCard);
});

it("換據點只重建一次；再次點擊、鍵盤選取及列表選取同一據點不重播進場", () => {
  click(pin("north")); const first = card();
  click(pin("south")); const second = card();
  expect(second).not.toBe(first);
  click(pin("south")); expect(card()).toBe(second);
  pin("south").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(card()).toBe(second);
  document.querySelector('[data-store-id="south"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  expect(card()).toBe(second);
  click(document.querySelector("#rs-desktop-card-close-btn")!);
  expect(card()?.textContent).toContain("點選地圖座標");
  click(pin("south")); expect(card()?.textContent).toContain("南部櫃點");
  expect(card()).not.toBe(second);
});

it("點圖釘會取消先前尚未執行的列表 snap", async () => {
  wheel().scrollTop = 52;
  wheel().dispatchEvent(new Event("scroll"));
  click(pin("north"));
  await vi.advanceTimersByTimeAsync(700);
  expect(card()?.textContent).toContain("北部櫃點");
  expect(scrollTo).toHaveBeenCalledTimes(1);
});
