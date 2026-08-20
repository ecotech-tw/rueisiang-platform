import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../../auth/session.js";
import { Icon } from "../../shell/icons.js";
import { useToast } from "../../shell/Toast.js";
import {
  useCountItem,
  useDeleteZoneImage,
  useUploadZoneImage,
  useZoneImages,
  type InventoryItem,
  type Zone,
} from "./api.js";

/**
 * 一項商品。
 *
 * 數量的 −／＋ 直接改，但走的是**盤點** API（PATCH /items/:id/count），不是
 * 一般的編輯——每一次調整都會留下「誰、什麼時候、從幾改到幾」。站在架子前面
 * 邊數邊按的人，就是在盤點，只是不用開另一張表單。
 */
function ZoneItem({ item, levelName }: { item: InventoryItem; levelName: string }) {
  const [expanded, setExpanded] = useState(false);
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
    <li className="zone-item">
      <div className="zone-item-row">
        <span className="zone-item-level" title={levelName}>{levelName}</span>
        <div className="zone-item-main">
          <div className="cell-strong">{item.name}</div>
          <div className="cell-sub">
            {item.sku || "沒有 SKU"}・{item.category}
          </div>
        </div>
        {canCount ? (
          <div className="quantity-stepper">
            <button
              type="button"
              aria-label={`${item.name} 減一`}
              disabled={shown <= 0}
              onClick={() => adjust(-1)}
            >
              −
            </button>
            <span className={low ? "stock-low" : undefined}>{shown.toLocaleString("zh-TW")}</span>
            <button type="button" aria-label={`${item.name} 加一`} onClick={() => adjust(1)}>
              ＋
            </button>
          </div>
        ) : (
          <span className={`zone-item-quantity${low ? " stock-low" : ""}`}>
            {shown.toLocaleString("zh-TW")} {item.unit}
          </span>
        )}
      </div>

      {/*
        * 備註與細節預設收起來。一個倉位可能有二三十項商品，每項都攤開三行的話
        * 就得一直捲——真正常看的是名稱與數量，其他是需要時才查的。
        */}
      <button type="button" className="link-button zone-item-toggle" onClick={() => setExpanded((open) => !open)}>
        <Icon name={expanded ? "chevronUp" : "plus"} />
        {expanded ? "收起" : "查看備註與商品資訊"}
      </button>

      {expanded ? (
        <dl className="zone-item-detail">
          <dt>單位</dt>
          <dd>{item.unit}</dd>
          <dt>安全庫存</dt>
          <dd>
            {item.minStock.toLocaleString("zh-TW")}
            {low ? <span className="status status-sync-failed">需要補貨</span> : null}
          </dd>
          <dt>備註</dt>
          <dd>{item.notes || "—"}</dd>
        </dl>
      ) : null}
    </li>
  );
}

/** 現場照片。上傳、預覽、刪除。 */
/** 瀏覽器真的畫得出來的格式。HEIC 通過 accept="image/*" 但顯示不出來。 */
const RENDERABLE = /^image\/(jpeg|png|webp|gif|avif)$/i;

function ZoneImages({ zoneId, canWrite }: { zoneId: string; canWrite: boolean }) {
  const [rejected, setRejected] = useState("");
  const images = useZoneImages(zoneId);
  const upload = useUploadZoneImage();
  const remove = useDeleteZoneImage();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <section className="zone-section">
      <div className="zone-section-head">
        <h3>區塊照片</h3>
        {canWrite ? (
          <>
            <button
              type="button"
              className="link-button"
              disabled={upload.isPending}
              onClick={() => fileRef.current?.click()}
            >
              {upload.isPending ? "上傳中…" : "＋ 上傳照片"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // 清掉才能連續上傳同一個檔名，不然 change 不會再觸發。
                // File 物件已經拿在手上了，清 value 不會讓它失效。
                event.target.value = "";
                if (!file) return;

                /*
                 * iPhone 直接拍的 HEIC 會通過 accept="image/*"，但瀏覽器畫不出來
                 * ——上傳成功、清單裡卻是一張破圖，看起來就像功能壞了。與其讓人
                 * 猜，不如在送出去之前就講清楚。
                 */
                if (!RENDERABLE.test(file.type)) {
                  setRejected(`「${file.name}」這種格式瀏覽器顯示不出來，請改用 JPG、PNG 或 WebP。`);
                  return;
                }
                setRejected("");
                upload.mutate({ zoneId, file }, { onSuccess: () => toast.show("照片已上傳") });
              }}
            />
          </>
        ) : null}
      </div>

      {/*
        * 上傳與刪除的錯誤都要顯示。先前只顯示上傳的——刪除失敗時畫面上一點反應
        * 都沒有，看起來就是「按了沒用」，但實際上是伺服器回了一句話沒人轉達。
        */}
      {upload.error ? <p className="form-error" role="alert">{upload.error.message}</p> : null}
      {remove.error ? <p className="form-error" role="alert">{remove.error.message}</p> : null}
      {rejected ? <p className="form-error" role="alert">{rejected}</p> : null}

      {images.data?.length ? (
        <div className="zone-images">
          {images.data.map((image) => (
            <figure key={image.id}>
              {/*
                * 圖片走 /api 而不是 R2 的公開網址：倉庫內部的照片，拿到連結的人
                * 不該就看得到。每次請求都會經過登入與權限檢查。
                */}
              <img src={`/api/wms/images/${image.id}`} alt={image.filename} loading="lazy" />
              {canWrite ? (
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={`刪除 ${image.filename}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(image.id, { onSuccess: () => toast.show("照片已刪除") })}
                >
                  <Icon name="trash" />
                </button>
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
   * 退場沒有，會比兩邊都沒有更奇怪。所以先標成 closing 讓 CSS 播退場，
   * 時間到了才真的收掉。
   *
   * 這裡的毫秒數要跟 components.css 的 drawer-out 對齊，改一邊就要改另一邊。
   */
  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, 200);
  }, [closing, onClose]);

  /** Esc 關掉。抽屜蓋住半個畫面，一定要有不用瞄準的關法。 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [requestClose]);

  const visible = level === "all" ? items : items.filter((item) => (item.shelfLevel ?? "") === level);
  const levelName = (id: string | null) =>
    zone.shelfLevels.find((candidate) => candidate.id === id)?.name ?? "未指定";

  return (
    <div
      className={`drawer-backdrop${closing ? " closing" : ""}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="zone-drawer-title">
        <header className={`drawer-head tone-${zone.color}`}>
          <button type="button" className="icon-button drawer-close" onClick={requestClose} aria-label="關閉">
            <Icon name="close" />
          </button>
          <p className="drawer-eyebrow">STORAGE ZONE</p>
          <div className="drawer-title">
            <span className="drawer-code">{zone.code}</span>
            <div>
              <h2 id="zone-drawer-title">{zone.name}</h2>
              <p className="muted">{zone.category}</p>
            </div>
          </div>
        </header>

        <div className="drawer-body">
          {canWrite ? (
            <div className="drawer-actions">
              <button type="button" className="ghost-button" onClick={onEdit}>修改區塊</button>
            </div>
          ) : null}

          <div className="stat-row drawer-stats">
            <div className="stat">
              <strong>{items.length}</strong>
              <span>商品品項</span>
            </div>
            <div className="stat">
              <strong>{images.data?.length ?? 0}</strong>
              <span>現場照片</span>
            </div>
          </div>

          {zone.notes ? <p className="muted drawer-notes">{zone.notes}</p> : null}

          {canReadItems ? (
            <section className="zone-section">
              <div className="zone-section-head">
                <h3>層架商品</h3>
                <span className="muted">新增商品請到「商品庫存」</span>
              </div>

              {/*
                * 層架分頁。每一層一個，前面加「全部」。
                * 標籤上不顯示數量：層架名稱本來就可能很長（「板模 1」「上層 A」），
                * 再加一個數字就得換行，一排分頁會變成兩排。
                */}
              <div className="level-tabs" role="tablist" aria-label="層架">
                <button
                  type="button"
                  role="tab"
                  aria-selected={level === "all"}
                  className={level === "all" ? "active" : ""}
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
                    className={level === shelf.id ? "active" : ""}
                    onClick={() => setLevel(shelf.id)}
                  >
                    {shelf.name}
                  </button>
                ))}
              </div>

              {visible.length ? (
                <ul className="zone-items-list">
                  {visible.map((item) => (
                    <ZoneItem key={item.id} item={item} levelName={levelName(item.shelfLevel)} />
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
