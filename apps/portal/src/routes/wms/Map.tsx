import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Icon } from "../../shell/icons.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Button, ButtonSkin, Page } from "../../ui/index.js";
import {
  useDeleteElement,
  useDeleteZone,
  useUpdateElement,
  useUpdateZone,
  useWarehouse,
  type InventoryItem,
  type LayoutElement,
  type Zone,
} from "./api.js";
import { CanvasDialog } from "./CanvasDialog.js";
import { downloadMapImage } from "./exportMap.js";
import { ElementDialog } from "./ElementDialog.js";
import { ELEMENT_BOUNDS, useDragBox, type Box } from "./useDragBox.js";
import { useMapViewport } from "./useMapViewport.js";
import { ZoneDialog } from "./ZoneDialog.js";
import { ZoneDrawer } from "./ZoneDrawer.js";

/**
 * 倉位地圖。
 *
 * **地圖鋪滿整個內容區，控制項浮在上面。** 先前是「標題列 ＋ 面板 ＋ 面板裡的
 * 地圖」，層層內距之後真正給地圖的高度只剩一半多一點。地圖是這一頁唯一的內容，
 * 其他東西都是為了操作它而存在的——那些該讓位，不該跟它平分畫面。
 *
 * 用絕對定位的 DOM 而不是 canvas（舊系統的互動地圖也是 DOM，它那份 canvas 是
 * 給「下載整張圖」用的，見 exportMap.ts）。方塊只有幾十個，DOM 完全撐得住，
 * 而文字換行、hover、鍵盤焦點、螢幕閱讀器在 canvas 上全都要自己重寫一遍。
 *
 * 畫布是**像素**尺寸加上 transform: scale，不是流動寬度。這樣倉位方塊有固定的
 * 像素大小，「這一格放得下幾個層架」才算得出來——用流動寬度的話那個答案會隨
 * 視窗變，每縮一次視窗層架就重排一次。
 */

function groupItems(items: InventoryItem[]): globalThis.Map<string, InventoryItem[]> {
  const grouped = new globalThis.Map<string, InventoryItem[]>();
  for (const item of items) {
    if (!item.zoneId) continue;
    const list = grouped.get(item.zoneId);
    if (list) list.push(item);
    else grouped.set(item.zoneId, [item]);
  }
  return grouped;
}

/**
 * 檢視模式下「點一下」的容差。
 *
 * 檢視模式不會啟動拖曳，所以 useDragBox 的容差幫不上忙——想用手指平移地圖的人
 * 一放開，剛才按著的那一格就會彈出抽屜。這裡自己記按下去的位置，移動超過幾個
 * 像素就當成平移，不是點擊。
 */
const CLICK_SLOP = 4;

function boxStyle(box: Box): React.CSSProperties {
  return { left: `${box.x}%`, top: `${box.y}%`, width: `${box.width}%`, height: `${box.height}%` };
}

/**
 * 一個倉位方塊裡列得下幾個商品。
 *
 * 每一列大約 17 像素，扣掉方塊自己的內距與上半部的代碼與名稱。放不下全部時
 * 最後一列改成「還有 +N 項」，所以可見的要再少一列。
 *
 * 單欄不分欄：商品名稱長（「童拾手工麻花捲隨手包-黃金芝麻」），分成兩欄之後
 * 每一欄都只剩兩三個字加省略號，等於什麼都沒說。
 */
function itemSlots(pixelHeight: number) {
  const rows = Math.floor((pixelHeight - 46) / 17);
  // 上限 8：再多字就疊成一團，而且方塊本身也放不下那麼多列。
  return Math.max(0, Math.min(8, rows));
}

/**
 * 地圖上的方塊：淡底＋深字，跟分類膠囊同一組色調。
 *
 * 每一色寫成完整字串、不用色名拼接：Tailwind 只掃得到完整的 class。
 * 色階清單見 api.ts 的 WAREHOUSE_CATEGORY_COLORS；不認得的色就不上色。
 */
const BOX_TONE: Record<string, string> = {
  rose: "bg-tone-rose/15 text-tone-rose",
  sky: "bg-tone-sky/15 text-tone-sky",
  mint: "bg-tone-mint/15 text-tone-mint",
  amber: "bg-tone-amber/15 text-tone-amber",
  violet: "bg-tone-violet/15 text-tone-violet",
  teal: "bg-tone-teal/15 text-tone-teal",
  peach: "bg-tone-peach/15 text-tone-peach",
  slate: "bg-tone-slate/15 text-tone-slate",
  lime: "bg-tone-lime/15 text-tone-lime",
  sand: "bg-tone-sand/15 text-tone-sand",
};

const BOX_BASE = "absolute flex flex-col px-[9px] py-[7px] border border-ink/18 rounded-[10px] overflow-hidden text-[12px] leading-[1.25]";

/** 配置模式下右下角的縮放把手，倉位與標籤共用。 */
const RESIZE_HANDLE =
  "absolute right-px bottom-px size-[15px] p-0 border-0 bg-transparent cursor-nwse-resize touch-none after:content-[''] after:absolute after:right-[3px] after:bottom-[3px] after:size-[7px] after:border-r-2 after:border-b-2 after:border-r-ink/50 after:border-b-ink/50";

/*
 * 浮起來的東西都要有自己的底，不然壓在地圖的方塊上就讀不到了。
 * 這是 Material 的 elevation：不是換顏色，是墊高一層。
 */
const NOTE_BASE = "max-w-full px-3 py-1.5 rounded-full text-[12px] shadow-panel";
const NOTE_QUIET = `${NOTE_BASE} bg-paper text-muted`;
const NOTE_LOUD = `${NOTE_BASE} bg-brand-soft text-brand-dark`;

/*
 * 浮在地圖上的控制項。
 *
 * pointer-events: none 加在容器、auto 加回子元素：不這樣做的話，這幾塊的空白
 * 區域會擋住底下的地圖——右上角那一塊看起來只有幾顆按鈕，實際上是一個蓋住
 * 三分之一畫面的透明矩形，那一帶的倉位就點不到了。
 *
 * 手機上改成貼齊上下緣、左右滿版。角落定位在 390px 的螢幕上會讓左上那組跟
 * 右上那組直接重疊。
 */
const FLOAT = "absolute z-2 flex gap-2 pointer-events-none *:pointer-events-auto max-[760px]:gap-1.5";

/*
 * 放了什麼商品。列數由 itemSlots 依方塊的像素高度算，放不下就收成「還有 N 項」，
 * 那一格換成墨色底，才不會跟商品名稱長得一模一樣。
 */
const ZONE_ITEM = "truncate rounded-[4px] px-[5px] py-px text-[10px] not-italic";

const ZOOM_BUTTON = "w-[26px] h-[26px] border-0 rounded-[50%] bg-transparent text-ink text-[15px] leading-none hover:not-disabled:bg-brand/7 disabled:text-muted";

interface ZoneLook {
  editing: boolean;
  selected: boolean;
  dragging: boolean;
  /** 沒在搜尋時是 null。 */
  match: boolean | null;
}

/**
 * 倉位方塊的狀態外觀。
 *
 * 幾種狀態會同時成立，誰蓋過誰要寫清楚：搜尋符合的輪廓連鍵盤焦點都蓋過去
 * （符合的格子要一眼找得到），層級則是搜尋 > 選中 > 拖曳。
 * 選中只加一圈輪廓，不換底色——換底色的話那一格就不再是它代表的顏色。
 * 搜尋時符合的浮起來、其他退到背景；整個藏起來會失去「它在哪一區」的脈絡。
 */
function zoneLook({ editing, selected, dragging, match }: ZoneLook) {
  const layer = match ? "z-1" : selected ? "z-4" : dragging ? "z-5" : "z-2";
  // touch-action: none 只放在拖得動的方塊上；放在捲動容器上的話整張圖都捲不動。
  const cursor = !editing ? "cursor-pointer" : dragging ? "cursor-grabbing touch-none" : "cursor-grab touch-none";
  const opacity = match === false ? "opacity-30" : dragging ? "opacity-85" : "";
  const outline = match
    ? "outline-2 outline-brand outline-offset-1"
    : `${selected ? "outline-2 outline-brand outline-offset-1" : ""} focus-visible:outline-2 focus-visible:outline-secondary focus-visible:outline-offset-2`;
  return `${layer} ${cursor} ${opacity} ${outline}`;
}

export function WarehouseMap() {
  usePageTitle("倉位地圖");
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [zoneForm, setZoneForm] = useState<Zone | "new" | null>(null);
  const [elementForm, setElementForm] = useState<LayoutElement | "new" | null>(null);
  const [canvasForm, setCanvasForm] = useState(false);
  const [deletingZone, setDeletingZone] = useState<Zone | null>(null);
  const [exporting, setExporting] = useState(false);
  /** 檢視模式下按在哪裡，用來分辨「點一下」與「平移」。 */
  const pressAt = useRef<{ x: number; y: number } | null>(null);
  /** pointerup 只記錄候選點擊，等 click 事件才開抽屜，避免同一個指標事件把抽屜立刻關掉。 */
  const clickCandidate = useRef<{ zoneId: string } | null>(null);

  const query = useWarehouse();
  const updateZone = useUpdateZone();
  const deleteZone = useDeleteZone();
  const updateElement = useUpdateElement();
  const deleteElement = useDeleteElement();
  const toast = useToast();
  const view = useMapViewport(query.data?.settings.canvasWidth ?? 0);
  const { permissions } = useSession();
  const canWrite = permissions.has("wms:map:write");
  const canReadItems = permissions.has("wms:inventory:read");

  const settings = query.data?.settings ?? { canvasWidth: 1600, canvasHeight: 900 };
  const zones = query.data?.zones ?? [];
  const elements = query.data?.layoutElements ?? [];
  const items = query.data?.items ?? [];
  const itemsByZone = groupItems(items);

  /*
   * 寫入失敗時要把暫存位置丟掉。不然方塊會停在一個伺服器不同意的地方，
   * 而且看起來像存成功了。
   */
  const zoneDrag = useDragBox(async (id, box) => {
    await updateZone.mutateAsync({ id, ...box });
    toast.show("倉位位置已更新");
  });
  const elementDrag = useDragBox(async (id, box) => {
    await updateElement.mutateAsync({ id, ...box });
    toast.show("地圖標示已更新");
  }, ELEMENT_BOUNDS);

  /**
   * 搜尋商品或 SKU，符合的倉位亮起來、其他暗下去。
   *
   * 找的是「東西在哪」而不是「有哪些東西」——所以結果不是一份清單，是把地圖上
   * 該去的那幾格標出來。沒放進任何倉位的商品另外算一個數字報出來，不然搜尋
   * 有結果、地圖上卻沒有任何一格亮起來會讓人以為壞了。
   */
  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return null;
    const found = items.filter((item) =>
      [item.name, item.sku ?? "", item.category, item.notes].some((value) => value.toLowerCase().includes(term)),
    );
    return {
      items: found.length,
      zoneIds: new Set(found.map((item) => item.zoneId).filter((id): id is string => Boolean(id))),
      unassigned: found.filter((item) => !item.zoneId).length,
    };
  }, [items, search]);

  /*
   * 拖完之後暫存位置要留到伺服器的值追上來為止，這裡負責通知它「資料更新了」。
   *
   * 沒有這一段的話，放開手到清單重新載入之間的那幾十毫秒，方塊會用伺服器上的
   * **舊**座標渲染——也就是使用者看到的「放開之後閃回原位再跳過去」。
   */
  useEffect(() => {
    zoneDrag.settle(zones);
    elementDrag.settle(elements);
  }, [zones, elements, zoneDrag.settle, elementDrag.settle]);

  const selectedZone = zones.find((zone) => zone.id === selected) ?? null;
  const error =
    query.error ?? updateZone.error ?? deleteZone.error ?? updateElement.error ?? deleteElement.error;

  async function exportImage() {
    setExporting(true);
    try {
      await downloadMapImage({ settings, zones, layoutElements: elements, items });
      toast.show("整張配置圖已下載，可以直接列印");
    } catch (failure) {
      toast.show(failure instanceof Error ? failure.message : "圖片產生失敗");
    } finally {
      setExporting(false);
    }
  }

  return (
    <Page layout="bleed" ref={view.rootRef as React.RefObject<HTMLDivElement>}>
      {/*
        * 三層結構：scroll（鋪滿、捲動）→ stage（佔住縮放後的空間）→ canvas（像素尺寸，
        * 用 transform 縮放）。
        *
        * 地圖比視窗小的時候置中（貼著角落看起來像沒載完）；safe 是必要的，純 center
        * 在內容比容器大時會把起點推到可視範圍外，左上角那一區就永遠捲不到了。
        *
        * 四周留白是**捲得到的留白**（內距在捲動容器上，不是在畫布上）：沒有它的話，
        * 捲到任何一邊時那一邊的浮動按鈕就正好壓在畫布邊緣的倉位上，看得到卻點不到。
        * 留白的量要蓋得過各角落的浮動面板；手機的浮動面板在上下兩端，留白也集中在上下。
        */}
      <div
        className="absolute inset-0 grid overflow-auto bg-canvas pt-24 pr-[100px] pb-[84px] pl-7 [place-content:safe_center] max-[760px]:px-4 max-[760px]:pt-[118px] max-[760px]:pb-[150px]"
        ref={view.scrollRef}
        onTouchStart={view.onTouchStart}
        onTouchMove={view.onTouchMove}
        onTouchEnd={view.onTouchEnd}
      >
        {/*
          * stage 佔住縮放後的空間，canvas 用 transform 縮放。只縮 canvas 的話
          * 捲動範圍不會跟著變，放大之後右下角就捲不到。
          */}
        <div
          className="relative"
          style={{ width: settings.canvasWidth * view.zoom, height: settings.canvasHeight * view.zoom }}
        >
          <div
            data-map-canvas
            // 淡格線幫忙對齊，但不搶戲；select-none 是因為拖曳時整段文字反白很難看。
            className="relative origin-top-left select-none [background:linear-gradient(var(--color-soft-line)_1px,transparent_1px)_0_0/100%_10%,linear-gradient(90deg,var(--color-soft-line)_1px,transparent_1px)_0_0/10%_100%]"
            style={{
              width: settings.canvasWidth,
              height: settings.canvasHeight,
              transform: `scale(${view.zoom})`,
            }}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) setSelected(null);
            }}
          >
            {elements.map((element) => {
              const box = elementDrag.boxOf(element.id, element);
              return (
                <div
                  key={element.id}
                  // 檢視模式的標籤只負責顯示，不能攔截倉位點擊；配置模式才拉到倉位上方拖曳。
                  // 虛線框、文字置中：牆、走道這種東西視覺上要退到倉位後面。
                  className={`${BOX_BASE} items-center justify-center border-dashed font-medium ${BOX_TONE[element.color] ?? ""} ${editing ? "z-3 pointer-events-auto cursor-grab touch-none" : "z-1 pointer-events-none"}`}
                  style={boxStyle(box)}
                  onPointerDown={(event) => editing && elementDrag.start(event, element.id, element, "move")}
                  onPointerMove={elementDrag.move}
                  onPointerUp={(event) => {
                    if (!elementDrag.end(event) && editing) setElementForm(element);
                  }}
                >
                  <span>{element.label}</span>
                  {editing ? (
                    <button
                      type="button"
                      className={RESIZE_HANDLE}
                      aria-label={`調整 ${element.label} 的大小`}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        elementDrag.start(event, element.id, element, "resize");
                      }}
                      onPointerMove={elementDrag.move}
                      onPointerUp={(event) => {
                        event.stopPropagation();
                        elementDrag.end(event);
                      }}
                    />
                  ) : null}
                </div>
              );
            })}

            {zones.map((zone) => {
              const box = zoneDrag.boxOf(zone.id, zone);
              const zoneItems = itemsByZone.get(zone.id) ?? [];
              const low = zoneItems.some((item) => item.quantity < item.minStock);

              /*
               * 依層架順序排，同一層之內照名稱。
               *
               * 地圖是拿來找東西的，所以列出來的順序要對得上架上實際由上而下的
               * 位置。沒有指定層架的排在最後——它們不在任何一層上。
               */
              const shelfOrder = new Map(zone.shelfLevels.map((level, index) => [level.id, index]));
              const listed = [...zoneItems].sort((a, b) => {
                const left = shelfOrder.get(a.shelfLevel ?? "") ?? Number.MAX_SAFE_INTEGER;
                const right = shelfOrder.get(b.shelfLevel ?? "") ?? Number.MAX_SAFE_INTEGER;
                return left - right || a.name.localeCompare(b.name, "zh-TW");
              });

              // 用畫布的像素尺寸算，不是螢幕上的——縮放不該改變列得下幾項。
              const slots = itemSlots((settings.canvasHeight * box.height) / 100);
              const overflowing = listed.length > slots;
              const visibleItems = listed.slice(0, overflowing ? Math.max(0, slots - 1) : slots);
              const hidden = listed.length - visibleItems.length;

              return (
                <article
                  key={zone.id}
                  className={`${BOX_BASE} ${BOX_TONE[zone.color] ?? ""} ${zoneLook({
                    editing,
                    selected: selected === zone.id,
                    dragging: zoneDrag.draggingId === zone.id,
                    match: matches ? matches.zoneIds.has(zone.id) : null,
                  })}`}
                  style={boxStyle(box)}
                  role="button"
                  tabIndex={editing ? -1 : 0}
                  aria-label={`${zone.code} ${zone.name}，放了 ${zoneItems.length} 項商品`}
                  onPointerDown={(event) => {
                    clickCandidate.current = null;
                    if (editing) zoneDrag.start(event, zone.id, zone, "move");
                    else pressAt.current = { x: event.clientX, y: event.clientY };
                  }}
                  onPointerMove={(event) => {
                    if (!editing && pressAt.current && Math.hypot(event.clientX - pressAt.current.x, event.clientY - pressAt.current.y) >= CLICK_SLOP) {
                      pressAt.current = null;
                    }
                    zoneDrag.move(event);
                  }}
                  onPointerUp={(event) => {
                    // 配置模式下點方塊是選它來拖，不是看明細。
                    if (zoneDrag.end(event) || editing) {
                      pressAt.current = null;
                      clickCandidate.current = null;
                      return;
                    }
                    const from = pressAt.current;
                    pressAt.current = null;
                    clickCandidate.current = from && Math.hypot(event.clientX - from.x, event.clientY - from.y) < CLICK_SLOP
                      ? { zoneId: zone.id }
                      : null;
                  }}
                  onClick={(event) => {
                    const candidate = clickCandidate.current;
                    clickCandidate.current = null;
                    if (candidate?.zoneId !== zone.id) return;
                    event.stopPropagation();
                    setSelected(zone.id);
                  }}
                  onKeyDown={(event) => {
                    if (!editing && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      setSelected(zone.id);
                    }
                  }}
                >
                  <span className="flex items-center justify-between gap-1">
                    <b className="text-[12px] font-bold">{zone.code}</b>
                    {low ? (
                      <i
                        className="grid size-[15px] flex-none place-items-center rounded-[50%] bg-brand text-[10px] font-bold not-italic text-white"
                        title="有商品低於安全庫存"
                      >
                        !
                      </i>
                    ) : null}
                  </span>
                  <span className="text-[11px] opacity-82">{zone.name}</span>
                  {/*
                    * 放了什麼，不是放了幾件。
                    *
                    * 數量在地圖上沒有用：站在倉庫裡看這張圖的人要找的是「那個東西
                    * 在哪一格」，不是「這一格總共幾件」。要看數量去商品庫存那一頁，
                    * 那裡才排得下也篩得動。方塊太小就整塊不畫——硬擠只會變成一團
                    * 看不懂的字。
                    */}
                  {/*
                    * hidden > 0 也要畫：只放得下一列而裡面有兩項以上時，
                    * visibleItems 會是空的、hidden 是全部——只看 visibleItems
                    * 的話這一格會整個空白，看起來像沒放東西。匯出那邊畫得出來，
                    * 兩邊不能不一致。
                    */}
                  {canReadItems && slots > 0 && (visibleItems.length > 0 || hidden > 0) ? (
                    <span className="mt-1 flex min-h-0 flex-col gap-0.5">
                      {visibleItems.map((item) => (
                        <em key={item.id} className={`${ZONE_ITEM} bg-paper/70`} title={item.name}>{item.name}</em>
                      ))}
                      {hidden > 0 ? (
                        <em className={`${ZONE_ITEM} bg-ink/8 opacity-75`} title={`還有 ${hidden} 項沒列出來`}>
                          還有 {hidden} 項
                        </em>
                      ) : null}
                    </span>
                  ) : null}

                  {editing ? (
                    <>
                      <button
                        type="button"
                        className="absolute top-[3px] right-[3px] size-[18px] rounded-[50%] border-0 bg-brand/90 p-0 text-[13px] leading-none text-white"
                        title={`刪除 ${zone.code}`}
                        aria-label={`刪除 ${zone.code} ${zone.name}`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          setDeletingZone(zone);
                        }}
                      >
                        ×
                      </button>
                      <button
                        type="button"
                        className={RESIZE_HANDLE}
                        aria-label={`調整 ${zone.code} 的大小`}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          zoneDrag.start(event, zone.id, zone, "resize");
                        }}
                        onPointerMove={zoneDrag.move}
                        onPointerUp={(event) => {
                          event.stopPropagation();
                          zoneDrag.end(event);
                        }}
                      />
                    </>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      </div>

      {/* 左上：標題與搜尋。搜尋是最常用的，放在最順手的角落。 */}
      {/* 標題、搜尋、提示由上往下疊，寬度跟著最寬的那個走。 */}
      <div className={`${FLOAT} top-4 left-4 max-w-[min(420px,calc(100%-32px))] flex-col items-start max-[760px]:top-2.5 max-[760px]:right-2.5 max-[760px]:left-2.5 max-[760px]:max-w-none`}>
        {/* 直接壓在地圖上，所以要有一點描邊才在淺色方塊上讀得出來。 */}
        <h1 className="m-0 px-1 text-[20px] [text-shadow:0_1px_0_var(--color-paper),0_0_6px_var(--color-paper)] max-[760px]:text-[17px]">倉位地圖</h1>
        <div className="w-full shadow-panel">
          <label className="flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-paper px-3 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-secondary">
            <Icon name="search" className="size-[18px] flex-none text-muted" />
            <input
              className="h-[38px] w-60 min-w-0 flex-1 border-0 bg-transparent text-[14px] focus:[outline:none] max-[760px]:w-auto"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜尋商品或 SKU…"
              aria-label="在地圖上搜尋商品"
            />
          </label>
        </div>
        {matches ? (
          <small aria-live="polite" className={NOTE_QUIET}>
            {matches.items
              ? `找到 ${matches.items} 項商品・${matches.zoneIds.size} 個倉位${
                  matches.unassigned ? `・${matches.unassigned} 項未設定倉位` : ""
                }`
              : "找不到符合的商品"}
          </small>
        ) : null}
        {editing ? (
          <small className={NOTE_LOUD}>
            配置模式：倉位與標籤可拖曳、右下角可縮放，右上角的 × 可刪除，點標籤可改名
          </small>
        ) : null}
        {error ? <small className={NOTE_LOUD} role="alert">{error.message}</small> : null}
      </div>

      {/* 右上：所有動作。 */}
      <ButtonSkin skin="floating"><div className={`${FLOAT} top-4 right-4 max-w-[calc(100%-32px)] flex-wrap justify-end max-[760px]:top-auto max-[760px]:right-2.5 max-[760px]:bottom-2.5 max-[760px]:left-2.5 max-[760px]:max-w-none max-[760px]:justify-start`}>
        {canWrite ? (
          <>
            <Button
              variant="secondary"
              active={editing}
              aria-pressed={editing}
              onClick={() => setEditing((on) => !on)}
            >
              {editing ? "✓ 完成配置" : "調整配置"}
            </Button>
            <Button icon="plus" type="button" onClick={() => setZoneForm("new")}>
              <span>新增區塊</span>
            </Button>
            <Button variant="secondary" icon="plus" type="button" onClick={() => setElementForm("new")}>
              <span>新增標籤</span>
            </Button>
            <Button variant="secondary" type="button" onClick={() => setCanvasForm(true)}>
              ▭ 畫布 {settings.canvasWidth} × {settings.canvasHeight}
            </Button>
          </>
        ) : null}

        <Button variant="secondary" type="button" disabled={exporting} onClick={() => void exportImage()}>
          {exporting ? "匯出中…" : "⇩ 下載整張圖"}
        </Button>
      </div></ButtonSkin>

      {/*
        * 右下：縮放。離內容最遠的角落，最不會擋到東西。
        *
        * 手機上放在動作列的正上方，不是右上角：右上角在 390px 的螢幕上會直接壓在
        * 滿版的搜尋列上；疊在動作列上面則是同一側、同一條軸線，而且拇指構得到。
        */}
      <ButtonSkin skin="floating"><div className={`${FLOAT} right-4 bottom-4 items-center max-[760px]:right-2.5 max-[760px]:bottom-[92px]`}>
        <div className="flex items-center gap-0.5 rounded-full border border-line bg-paper p-0.5 shadow-panel">
          <button type="button" className={ZOOM_BUTTON} aria-label="縮小" disabled={!view.canZoomOut} onClick={() => view.zoomTo(view.zoom - 0.1)}>−</button>
          <span className="min-w-11 text-center text-[12px] tabular-nums">{Math.round(view.zoom * 100)}%</span>
          <button type="button" className={ZOOM_BUTTON} aria-label="放大" disabled={!view.canZoomIn} onClick={() => view.zoomTo(view.zoom + 0.1)}>＋</button>
        </div>
        <Button
          variant="icon"
          aria-pressed={view.fullscreen}
          title={view.fullscreen ? "退出全螢幕（Esc）" : "全螢幕"}
          aria-label={view.fullscreen ? "退出全螢幕" : "全螢幕"}
          onClick={() => void view.toggleFullscreen()}
        >
          <span aria-hidden="true">{view.fullscreen ? "↙" : "⛶"}</span>
        </Button>
      </div></ButtonSkin>

      {selectedZone && !editing ? (
        <ZoneDrawer
          zone={selectedZone}
          items={itemsByZone.get(selectedZone.id) ?? []}
          onClose={() => setSelected(null)}
          onEdit={() => setZoneForm(selectedZone)}
        />
      ) : null}

      {zoneForm ? (
        <ZoneDialog zone={zoneForm === "new" ? undefined : zoneForm} onClose={() => setZoneForm(null)} />
      ) : null}

      {elementForm ? (
        <ElementDialog
          element={elementForm === "new" ? undefined : elementForm}
          onClose={() => setElementForm(null)}
          onDeleted={() => setElementForm(null)}
        />
      ) : null}

      {canvasForm ? <CanvasDialog settings={settings} onClose={() => setCanvasForm(false)} /> : null}

      {deletingZone ? (
        <ConfirmDialog
          title="刪除這個倉位？"
          confirmLabel="刪除"
          pending={deleteZone.isPending}
          onCancel={() => setDeletingZone(null)}
          onConfirm={() =>
            deleteZone.mutate(deletingZone.id, {
              onSuccess: () => {
                toast.show(`已刪除「${deletingZone.code} ${deletingZone.name}」`);
                setDeletingZone(null);
                setSelected(null);
              },
            })
          }
        >
          <p><strong>{deletingZone.code} {deletingZone.name}</strong> 會從地圖上移除，現場照片也會一起刪掉。</p>
          <p className="text-muted">裡面還有商品的話刪不掉，要先把它們移到別的倉位。</p>
        </ConfirmDialog>
      ) : null}
    </Page>
  );
}
