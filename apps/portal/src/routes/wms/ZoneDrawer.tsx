import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useSession } from "../../auth/session.js";
import { Icon } from "../../shell/icons.js";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, ButtonSkin, Stat, StatRow, useModalFocus } from "../../ui/index.js";
import {
  useCountItem,
  useDeleteZoneImage,
  useUploadZoneImage,
  useZoneImages,
  type InventoryItem,
  type Zone,
} from "./api.js";
import { STOCK_LOW } from "./stock-low.js";

const STEPPER_BUTTON = "size-7 rounded-[50%] border-0 bg-transparent text-[15px] leading-none text-ink enabled:hover:bg-brand/7 disabled:text-muted";

/** 商品細節的一格：標籤在上、值在下。 */
function ItemField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="grid min-w-0 gap-0.5">
      <small className="text-[11px] text-muted">{label}</small>
      <b className="overflow-hidden text-[13px] text-ellipsis">{children}</b>
    </span>
  );
}

/** 層架分頁的一顆。選中與否由 state 決定；選中那顆 hover 不疊色。 */
function levelTabClass(active: boolean) {
  return active
    ? "rounded-full border-0 bg-paper px-3.5 py-[5px] text-[13px] font-bold text-ink"
    : "rounded-full border-0 bg-transparent px-3.5 py-[5px] text-[13px] font-medium text-muted hover:bg-brand/5";
}

/**
 * 一項商品。
 *
 * 數量的 −／＋ 直接改，但走的是**盤點** API（PATCH /items/:id/count），不是
 * 一般的編輯——每一次調整都會留下「誰、什麼時候、從幾改到幾」。站在架子前面
 * 邊數邊按的人，就是在盤點，只是不用開另一張表單。
 */
function ZoneItem({ item, levelName, placeLabel }: { item: InventoryItem; levelName: string; placeLabel: string }) {
  /*
   * 按 −／＋ 時先動畫面上的數字，不要等伺服器回來。
   *
   * 連按五下的情況很常見；每一下都等一次往返的話，數字會一格一格慢慢跳，
   * 而且中途的點擊會落在還沒更新的值上。這裡自己累加，送出去的是最終值。
   */
  const [draft, setDraft] = useState<number | null>(null);
  const count = useCountItem();
  const toast = useToast();
  const { permissions } = useSession();
  const canCount = permissions.has("wms:inventory:count");

  const shown = draft ?? item.quantity;
  const low = shown < item.minStock;

  /*
   * 伺服器的值追上來之後就把暫存丟掉，回到「以伺服器為準」。沒有這一步的話，
   * 別人改了同一項商品時這裡會一直顯示我自己的舊數字。
   */
  useEffect(() => {
    if (draft !== null && item.quantity === draft) setDraft(null);
  }, [item.quantity, draft]);

  function adjust(delta: number) {
    const next = Math.max(0, shown + delta);
    setDraft(next);
    count.mutate(
      { id: item.id, quantity: next, note: "在倉位地圖上調整數量" },
      {
        onError: () => {
          setDraft(null);
          toast.show(`「${item.name}」的數量沒有存起來`);
        },
      },
    );
  }

  return (
    <li className="rounded-field border border-soft-line px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        {/* 層架徽章。名字可能很長，限寬省略而不是把整列撐開。 */}
        <span className="max-w-[62px] flex-none truncate rounded-[6px] bg-canvas px-2 py-[3px] text-[11px] text-muted" title={levelName}>{levelName}</span>
        <div className="min-w-0 flex-1">
          <div className="cell-strong">{item.name}</div>
          <div className="cell-sub">
            {item.sku || "沒有 SKU"}・{item.category}
          </div>
        </div>
        {canCount ? (
          /* 數量的 −／＋。中間的數字寬度固定，按的時候按鈕不會左右跳。 */
          <div className="flex flex-none items-center gap-0.5 rounded-full border border-line p-0.5">
            <button
              type="button"
              className={STEPPER_BUTTON}
              aria-label={`${item.name} 減一`}
              disabled={shown <= 0}
              onClick={() => adjust(-1)}
            >
              −
            </button>
            <span className={`min-w-[46px] text-center text-[14px] font-bold tabular-nums ${ low ? STOCK_LOW : "" }`}>{shown.toLocaleString("zh-TW")}</span>
            <button type="button" className={STEPPER_BUTTON} aria-label={`${item.name} 加一`} onClick={() => adjust(1)}>
              ＋
            </button>
          </div>
        ) : (
          <span className={`flex-none font-bold ${ low ? STOCK_LOW : "" }`}>
            {shown.toLocaleString("zh-TW")} {item.unit}
          </span>
        )}
      </div>

      {/*
        * 備註與細節預設收起來。一個倉位可能有二三十項商品，每項都攤開的話就得
        * 一直捲——常看的是名稱與數量，其他是需要時才查的。
        *
        * 用原生的 <details>：開合本來就是它的工作，不需要一個 state、一個
        * onClick、一個條件渲染，而且鍵盤與螢幕閱讀器的行為都是免費的。
        * 瀏覽器預設的三角形標記要自己收掉，展開的提示改用 ＋／−，跟這個系統其他地方的語彙一致。
        * 展開之後把 ＋ 換成 −，不然「已經開著」跟「可以打開」看起來一樣。
        */}
      <details className="group mt-2">
        <summary className="inline-flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden gap-1 text-[12px] text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="group-open:invisible group-open:relative group-open:before:visible group-open:before:absolute group-open:before:inset-0 group-open:before:content-['−']">＋</span> 查看備註與商品資訊
        </summary>
        {/* 兩欄的欄位表：標籤在上、值在下，比左右對照省橫向空間。 */}
        <div className="mt-2.5 grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-x-3.5 gap-y-2.5 rounded-field bg-canvas px-3.5 py-3">
          <ItemField label="倉位 / 層架">{placeLabel}</ItemField>
          <ItemField label="SKU">{item.sku || "未設定"}</ItemField>
          <ItemField label="分類">{item.category}</ItemField>
          <ItemField label="安全庫存">{item.minStock.toLocaleString("zh-TW")} {item.unit}</ItemField>
        </div>
        <div className="mt-2 px-0.5">
          <small className="text-[11px] text-muted">備註</small>
          {/* 沒有備註時整段淡下去——它是「這裡本來就沒東西」，不是要讀的內容。 */}
          <p className={`mt-0.5 text-[13px] leading-normal ${item.notes ? "" : "text-muted"}`}>{item.notes || "目前沒有備註"}</p>
        </div>
      </details>
    </li>
  );
}

/** 瀏覽器真的畫得出來的格式。HEIC 通過 accept="image/*" 但顯示不出來。 */
const RENDERABLE = /^image\/(jpeg|png|webp|gif|avif)$/i;

/**
 * 現場照片。上傳、預覽、刪除。
 *
 * 上傳的觸發是**一個透明、鋪滿整塊放置區的 input 本身**，沒有按鈕、沒有 label、
 * 沒有 ref.click()。中間每多一層轉介就多一個會壞掉的地方，而這條路已經因為
 * 那些轉介壞過兩次了。詳見下面 input 上的說明。
 *
 * 整塊區域都是放置區，不只是那行小字——上傳照片的人手上拿著檔案，目標大一點
 * 比較好按，拖進來也行。
 */
function ZoneImages({ zoneId, canWrite }: { zoneId: string; canWrite: boolean }) {
  const [rejected, setRejected] = useState("");
  const [dragging, setDragging] = useState(false);
  const images = useZoneImages(zoneId);
  const upload = useUploadZoneImage();
  const remove = useDeleteZoneImage();
  const toast = useToast();
  /** label 要指到 input，而同一頁可能同時有多個抽屜的殘影，所以帶上 zoneId。 */
  const inputId = `zone-photo-${zoneId}`;

  function accept(file: File | undefined) {
    // 上傳中再丟一張進來（拖曳或連點）就是重複上傳同一批照片；等這張傳完再說。
    if (!file || upload.isPending) return;
    /*
     * iPhone 直接拍的 HEIC 會通過 accept="image/*"，但瀏覽器畫不出來——上傳成功、
     * 清單裡卻是一張破圖，看起來就像功能壞了。與其讓人猜，不如先講清楚。
     */
    if (!RENDERABLE.test(file.type)) {
      setRejected(`「${file.name}」這種格式瀏覽器顯示不出來，請改用 JPG、PNG 或 WebP。`);
      return;
    }
    setRejected("");
    upload.mutate({ zoneId, file }, { onSuccess: () => toast.show("照片已上傳") });
  }

  return (
    <section className="grid gap-2.5">
      <div className="flex items-baseline justify-between gap-2.5">
        <h3 className="text-[14px] font-bold">區塊照片</h3>
        {/*
          * 沒有權限時明講，不要把按鈕悄悄藏起來——「這裡本來就沒有上傳功能」跟
          * 「我沒有權限」對使用者是兩件事，後者他知道該找誰。
          */}
        {canWrite ? null : <span className="muted text-[12px]">需要地圖編輯權限才能上傳</span>}
      </div>

      {/*
        * 上傳與刪除的錯誤都要顯示。先前只顯示上傳的——刪除失敗時畫面上一點反應
        * 都沒有，看起來就是「按了沒用」，但實際上是伺服器回了一句話沒人轉達。
        */}
      {upload.error ? <Alert tone="danger">{upload.error.message}</Alert> : null}
      {remove.error ? <Alert tone="danger">{remove.error.message}</Alert> : null}
      {rejected ? <Alert tone="danger">{rejected}</Alert> : null}

      {canWrite ? (
        /*
         * 上傳照片的放置區。整塊都可點（而不是一行小字），因為手上拿著檔案要上傳的人
         * 需要一個好按的目標。拖曳經過時整塊亮起來——不然使用者不知道可以放在哪裡。
         * 鍵盤走到那個透明的 input 時，焦點框畫在看得見的外框上（has-focus-visible）。
         */
        <div
          className={`relative grid place-items-center gap-0.5 rounded-field border px-3 py-[18px] text-[13px] text-muted has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-secondary ${dragging ? "border-solid border-brand bg-brand-soft" : "border-dashed border-line bg-canvas hover:border-secondary hover:bg-brand/4"} ${upload.isPending ? "opacity-70" : ""}`}
          onDragOver={(event) => {
            // 不擋掉預設行為的話，瀏覽器會直接把檔案當成網址打開，整頁被取代。
            event.preventDefault();
            if (!upload.isPending) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            accept(event.dataTransfer.files?.[0]);
          }}
        >
          {/*
            * **不要把 input 包在 <label> 裡。**
            *
            * 直接點在 input 上時，input 自己會處理那次點擊，label 又會再轉發一次
            * 合成的點擊給它——Chrome 把重複的那一次當成非使用者手勢取消掉，
            * 於是檔案選擇器就不開了。這個行為跟版本與時序有關，所以會出現
            * 「有些人可以、有些人不行」。
            *
            * 這裡沒有 label：input 自己就是唯一的互動元素，透明鋪滿整塊，
            * 底下那個 div 只負責長相。點擊只會發生一次，沒有東西可以轉發。
            *
            * 不能用 opacity 以外的方式藏它：display: none 與 visibility: hidden 會讓它
            * 不能被點到，sr-only 會把它縮成 1×1，兩者都得靠轉介才點得到。
            */}
          {/*
            * 上傳中不用 disabled：停用的 input 會把鍵盤焦點丟掉，用鍵盤選完檔案的人
            * 一按下去就不知道自己在哪了。改成 aria-disabled ＋ 擋掉這次點擊，
            * 檔案選擇器不會再開，焦點留在原地。input 鋪滿整塊，游標要畫在它身上才看得到。
            */}
          <input
            id={inputId}
            type="file"
            className={`absolute inset-0 size-full opacity-0 ${upload.isPending ? "cursor-progress" : "cursor-pointer"}`}
            accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
            aria-label="上傳倉位現場照片"
            aria-disabled={upload.isPending || undefined}
            onClick={(event) => {
              if (upload.isPending) event.preventDefault();
            }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // 清掉才能連續上傳同一個檔名，不然 change 不會再觸發。
              // File 物件已經拿在手上了，清 value 不會讓它失效。
              event.target.value = "";
              accept(file);
            }}
          />
          <Icon name="plus" className="size-5" />
          <span className="font-bold text-ink">{upload.isPending ? "上傳中…" : "上傳照片"}</span>
          <small className="text-[11px]">點一下選檔案，或把照片拖進來</small>
        </div>
      ) : null}

      {images.data?.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
          {images.data.map((image) => (
            <figure key={image.id} className="relative">
              {/*
                * 圖片走 /api 而不是 R2 的公開網址：倉庫內部的照片，拿到連結的人
                * 不該就看得到。每次請求都會經過登入與權限檢查。
                */}
              <img
                src={`/api/wms/images/${image.id}`}
                alt={image.filename}
                loading="lazy"
                className="block aspect-4/3 w-full rounded-field bg-canvas object-cover"
              />
              {canWrite ? (
                <ButtonSkin skin="paper">
                  <Button
                    variant="icon"
                    tone="danger"
                    className="absolute top-1 right-1"
                    icon="trash"
                    aria-label={`刪除 ${image.filename}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(image.id, { onSuccess: () => toast.show("照片已刪除") })}
                  />
                </ButtonSkin>
              ) : null}
            </figure>
          ))}
        </div>
      ) : (
        <p className="muted">
          還沒有照片。{canWrite ? "拍一張架上的樣子，之後找東西時比文字好用。" : ""}
        </p>
      )}
    </section>
  );
}

/*
 * 進場與退場的動畫（keyframes 在 components.css）。
 *
 * 抽屜從右邊滑進來，遮罩淡入。用 Material 的 emphasized decelerate——進場快、
 * 收尾慢，看起來像被推進來停住，而不是等速滑行。退場用對稱的 accelerate：
 * 離開的東西不需要慢慢停，快一點反而俐落。動畫純粹是修飾，減少動態時整組關掉。
 */
const DRAWER_ENTER = {
  backdrop: "animate-[drawer-fade-in_200ms_ease-out]",
  panel: "animate-[drawer-slide-in_280ms_cubic-bezier(.05,.7,.1,1)]",
};
const DRAWER_EXIT = {
  backdrop: "animate-[drawer-fade-in_180ms_ease-in_reverse_forwards]",
  panel: "animate-[drawer-slide-out_180ms_cubic-bezier(.3,0,.8,.15)_forwards]",
};

/**
 * 倉位明細。
 *
 * 做成右側抽屜而不是置中對話框：內容很長（統計、層架分頁、商品清單、照片），
 * 置中的對話框在桌機上會變成一個又高又窄的東西，而且點開之後看不到自己剛才
 * 點的是地圖上哪一格。抽屜貼著右邊，地圖仍然看得見。
 */
export function ZoneDrawer({
  zone,
  items,
  onClose,
  onEdit,
}: {
  zone: Zone;
  items: InventoryItem[];
  onClose: () => void;
  onEdit: () => void;
}) {
  const [level, setLevel] = useState("all");
  const [closing, setClosing] = useState(false);
  const { permissions } = useSession();
  const canWrite = permissions.has("wms:map:write");
  const canReadItems = permissions.has("wms:inventory:read");
  const images = useZoneImages(zone.id);

  /**
   * 關閉要等退場動畫跑完。
   *
   * 直接呼叫 onClose 的話元件立刻卸載，滑進來的東西「啪」一聲消失——進場有動畫、
   * 退場沒有，會比兩邊都沒有更奇怪。所以先標成 closing 讓退場動畫播完，
   * 時間到了才真的收掉。
   *
   * 這裡的 200ms 要蓋過下面 DRAWER_EXIT 的 180ms，改一邊就要改另一邊。
   */
  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, 200);
  }, [closing, onClose]);

  /*
   * 抽屜是 modal（蓋住半個畫面、背後不能操作），鍵盤行為要跟對話框一樣：打開時焦點移進來、
   * Tab 不會跑到被蓋住的地圖上、Esc 關掉（一定要有不用瞄準的關法）、關掉後焦點回到剛才點的那一格。
   * 「修改區塊」的對話框會疊在抽屜上面，那時候由上層的對話框接手。
   */
  const panelRef = useRef<HTMLElement>(null);
  useModalFocus(panelRef, { onEscape: requestClose });

  const visible = level === "all" ? items : items.filter((item) => (item.shelfLevel ?? "") === level);
  const levelName = (id: string | null) =>
    zone.shelfLevels.find((candidate) => candidate.id === id)?.name ?? "未指定";

  return (
    <div
      className={`fixed inset-0 z-40 flex justify-end bg-ink/32 motion-reduce:animate-none ${closing ? DRAWER_EXIT.backdrop : DRAWER_ENTER.backdrop}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      {/* 抽屜在手機上是滿版的，不然商品那幾列擠不下。 */}
      <aside
        className={`flex w-[min(520px,100%)] flex-col bg-paper [box-shadow:var(--shadow-panel)] motion-reduce:animate-none max-[760px]:w-full ${closing ? DRAWER_EXIT.panel : DRAWER_ENTER.panel}`}
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="zone-drawer-title"
      >
        {/* 頁首的底色跟著區塊的色階；色階清單是 WAREHOUSE_CATEGORY_COLORS，對應的 --color-tone-* 在 theme.css。 */}
        <header
          className="relative bg-(--tone)/18 px-6 pt-[22px] pb-[18px] text-(--tone) max-[760px]:px-4 max-[760px]:pt-[18px] max-[760px]:pb-3.5"
          style={{ "--tone": `var(--color-tone-${zone.color})` } as CSSProperties}
        >
          <Button variant="icon" className="absolute top-3.5 right-3.5" icon="close" type="button" onClick={requestClose} aria-label="關閉" />
          <p className="mx-0 mt-0 mb-2.5 text-[11px] font-bold tracking-[.12em] opacity-65">STORAGE ZONE</p>
          <div className="flex items-center gap-3.5">
            {/* 代碼做成一個方牌，跟名稱分開——它是編號不是標題。 */}
            <span className="grid size-[62px] flex-none place-items-center rounded-xl bg-paper/75 text-[15px] font-bold">{zone.code}</span>
            <div>
              <h2 id="zone-drawer-title" className="m-0 text-[21px]">{zone.name}</h2>
              <p className="muted mx-0 mt-0.5 mb-0 text-[13px]">{zone.category}</p>
            </div>
          </div>
        </header>

        <div className="grid flex-1 content-start gap-[18px] overflow-y-auto px-6 pt-[18px] pb-7 max-[760px]:px-4 max-[760px]:pt-3.5 max-[760px]:pb-6">
          {canWrite ? (
            <div className="flex justify-end">
              <Button variant="secondary" type="button" onClick={onEdit}>修改區塊</Button>
            </div>
          ) : null}

          <StatRow>
            <Stat valueFirst label="商品品項" value={items.length} />
            <Stat valueFirst label="現場照片" value={images.data?.length ?? 0} />
          </StatRow>

          {zone.notes ? <p className="muted m-0 text-[13px]">{zone.notes}</p> : null}

          {canReadItems ? (
            <section className="grid gap-2.5">
              <div className="flex items-baseline justify-between gap-2.5">
                <h3 className="text-[14px] font-bold">層架商品</h3>
                <span className="muted text-[12px]">新增商品請到「商品庫存」</span>
              </div>

              {/*
                * 層架分頁。每一層一個，前面加「全部」。放不下就換行，不要橫向捲——一排看得完才知道有幾層。
                * 標籤上不顯示數量：層架名稱本來就可能很長（「板模 1」「上層 A」），
                * 再加一個數字就得換行，一排分頁會變成兩排。
                */}
              <div className="flex flex-wrap gap-1 rounded-full bg-canvas p-1" role="tablist" aria-label="層架">
                <button
                  type="button"
                  role="tab"
                  aria-selected={level === "all"}
                  className={levelTabClass(level === "all")}
                  onClick={() => setLevel("all")}
                >
                  全部
                </button>
                {zone.shelfLevels.map((shelf) => (
                  <button
                    key={shelf.id}
                    type="button"
                    role="tab"
                    aria-selected={level === shelf.id}
                    className={levelTabClass(level === shelf.id)}
                    onClick={() => setLevel(shelf.id)}
                  >
                    {shelf.name}
                  </button>
                ))}
              </div>

              {visible.length ? (
                <ul className="grid gap-2">
                  {visible.map((item) => (
                    <ZoneItem
                      key={item.id}
                      item={item}
                      levelName={levelName(item.shelfLevel)}
                      placeLabel={`${zone.code}・${levelName(item.shelfLevel)}`}
                    />
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  {items.length ? "這一層還沒有放東西。" : "這個倉位還沒有放東西。"}
                </p>
              )}
            </section>
          ) : null}

          <ZoneImages zoneId={zone.id} canWrite={canWrite} />
        </div>
      </aside>
    </div>
  );
}
