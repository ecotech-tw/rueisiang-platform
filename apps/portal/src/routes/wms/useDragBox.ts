import { useCallback, useRef, useState } from "react";

/** 方塊在畫布上的位置與大小，單位是百分比。 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 座標與尺寸的合法範圍。跟 packages/db 的 BOUNDS 是同一組值。
 *
 * 倉位保留較大的最小尺寸，避免代碼、名稱與商品擠成看不懂；地圖標示是輔助文字，
 * 可以縮到更小。前端與後端要用同一組數值，否則拖曳預覽會停在伺服器不接受的位置。
 */
export interface BoxBounds {
  x: { min: number; max: number };
  y: { min: number; max: number };
  width: { min: number; max: number };
  height: { min: number; max: number };
}

const ZONE_BOUNDS: BoxBounds = {
  x: { min: 0, max: 92 },
  y: { min: 0, max: 92 },
  width: { min: 8, max: 42 },
  height: { min: 8, max: 38 },
};

export const ELEMENT_BOUNDS: BoxBounds = {
  x: { min: 0, max: 92 },
  y: { min: 0, max: 92 },
  width: { min: 2, max: 42 },
  height: { min: 2, max: 38 },
};

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/** 小於這個距離就當成點擊，不是拖曳。單位是像素。 */
const CLICK_SLOP = 4;

type Mode = "move" | "resize";

interface DragState {
  id: string;
  mode: Mode;
  /** 按下去時的指標位置與方塊狀態，用來算位移。 */
  pointerX: number;
  pointerY: number;
  origin: Box;
  /** 畫布的像素尺寸，換算百分比要用。 */
  canvasWidth: number;
  canvasHeight: number;
  bounds: BoxBounds;
  moved: boolean;
}

/**
 * 在畫布上拖曳與縮放方塊。
 *
 * 兩個刻意的決定：
 *
 * **拖曳過程不打 API，放開才送一次。** 拖一次會經過幾百個 pointermove，每一個
 * 都送就是幾百個請求，而且它們會亂序抵達——最後存進資料庫的可能是中途的某個
 * 位置。過程中只改本地狀態，畫面照樣即時跟著手指走。
 *
 * **位移小於幾個像素就當成點擊。** 用滑鼠點東西的時候手一定會抖一兩個像素，
 * 沒有這個容差的話「點一下看裡面有什麼」會變成「不小心把它移動了 1%」，
 * 而且還留下一筆移動紀錄。
 */
function sameBox(left: Box, right: Box): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function matchesBoxPatch(box: Box, patch: Partial<Box>): boolean {
  return (patch.x === undefined || box.x === patch.x)
    && (patch.y === undefined || box.y === patch.y)
    && (patch.width === undefined || box.width === patch.width)
    && (patch.height === undefined || box.height === patch.height);
}

function boxAtPointer(state: DragState, clientX: number, clientY: number): Box {
  const dx = clientX - state.pointerX;
  const dy = clientY - state.pointerY;
  const percentX = (dx / state.canvasWidth) * 100;
  const percentY = (dy / state.canvasHeight) * 100;
  const { origin, bounds } = state;

  return state.mode === "move"
    ? {
        ...origin,
        x: clamp(origin.x + percentX, bounds.x),
        y: clamp(origin.y + percentY, bounds.y),
      }
    : {
        ...origin,
        width: clamp(origin.width + percentX, bounds.width),
        height: clamp(origin.height + percentY, bounds.height),
      };
}

export function useDragBox(
  onCommit: (id: string, box: Partial<Box>) => void | PromiseLike<unknown>,
  bounds: BoxBounds = ZONE_BOUNDS,
) {
  const state = useRef<DragState | null>(null);
  /** 拖曳中的暫時位置。只有這一個方塊會偏離伺服器上的值。 */
  const [preview, setPreview] = useState<{ id: string; box: Box } | null>(null);
  /** 同一個方塊快速連續操作時，讓後一次寫入排在前一次之後，避免回應亂序覆蓋新位置。 */
  const commitQueue = useRef(Promise.resolve());

  const enqueueCommit = useCallback((id: string, box: Partial<Box>) => {
    const task = commitQueue.current
      .catch(() => undefined)
      .then(() => onCommit(id, box));
    commitQueue.current = task.then(() => undefined, () => undefined);
    void task.catch(() => {
      setPreview((current) => {
        if (!current || current.id !== id) return current;
        return matchesBoxPatch(current.box, box) ? null : current;
      });
    });
  }, [onCommit]);

  const start = useCallback(
    (event: React.PointerEvent, id: string, box: Box, mode: Mode) => {
      // 只理左鍵：右鍵要留給瀏覽器的選單，中鍵是貼上。
      if (event.button !== 0) return;

      const canvas = event.currentTarget.closest(".map-canvas");
      if (!(canvas instanceof HTMLElement)) return;
      const rect = canvas.getBoundingClientRect();

      event.preventDefault();
      // 抓住指標：拖到畫布外、甚至視窗外，事件仍然回到這個元素。
      event.currentTarget.setPointerCapture(event.pointerId);

      state.current = {
        id,
        mode,
        pointerX: event.clientX,
        pointerY: event.clientY,
        origin: box,
        canvasWidth: rect.width,
        canvasHeight: rect.height,
        bounds,
        moved: false,
      };
      setPreview({ id, box });
    },
    [bounds],
  );

  const move = useCallback((event: React.PointerEvent) => {
    const current = state.current;
    if (!current) return;

    const dx = event.clientX - current.pointerX;
    const dy = event.clientY - current.pointerY;
    if (!current.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
    current.moved = true;

    // 像素換成百分比：畫布多大都一樣，縮放視窗不會讓拖曳的比例跑掉。
    setPreview({ id: current.id, box: boxAtPointer(current, event.clientX, event.clientY) });
  }, []);

  /**
   * 回傳 true 代表這是一次拖曳，呼叫端就不該再把它當成點擊。
   *
   * **放開手時不清掉暫存位置。** 清掉的話，從送出請求到伺服器回來、清單重新
   * 載入之間的那幾十毫秒，方塊會用伺服器上的**舊**座標渲染——看起來就是放開
   * 之後閃回原位再跳到新位置。暫存要留到 settle() 確認伺服器追上來為止。
   */
  const end = useCallback(
    (event: React.PointerEvent): boolean => {
      const current = state.current;
      state.current = null;
      if (!current) {
        setPreview(null);
        return false;
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!current.moved) {
        // 只是點了一下，沒有要送任何東西，暫存直接丟掉。
        setPreview(null);
        return false;
      }

      const box = boxAtPointer(current, event.clientX, event.clientY);
      /*
       * pointerup 不保證前面一定有一個同座標的 pointermove。這裡要把最後提交的值
       * 同時寫進預覽，不然伺服器回傳新座標後，舊預覽會被誤認成「尚未同步」；下一次
       * 拖曳就會從舊位置計算，造成方塊飄移。
       */
      setPreview({ id: current.id, box });

      /*
       * 只送真的改了的那兩個欄位。整包送的話，後端會把「當下畫面上的值」全部
       * 寫回去，包含別人剛改過的名稱或層架。
       */
      enqueueCommit(
        current.id,
        current.mode === "move"
          ? { x: box.x, y: box.y }
          : { width: box.width, height: box.height },
      );
      return true;
    },
    [enqueueCommit],
  );

  /** 這個方塊此刻該畫在哪。拖曳中（或還在等伺服器）的用暫存值，其他的用伺服器的值。 */
  const boxOf = useCallback(
    (id: string, box: Box): Box => (preview?.id === id ? preview.box : box),
    [preview],
  );

  /**
   * 伺服器的值追上來了就把暫存丟掉，回到「以伺服器為準」。
   *
   * 呼叫端在資料更新之後呼叫。留著暫存不放的話，別人改了同一個方塊時這裡會
   * 一直顯示我自己的舊位置。找不到那個 id（被刪掉了）也一樣丟掉。
   */
  const settle = useCallback((boxes: (Box & { id: string })[]) => {
    setPreview((current) => {
      if (!current) return current;
      const server = boxes.find((candidate) => candidate.id === current.id);
      if (!server) return null;
      return sameBox(server, current.box) ? null : current;
    });
  }, []);

  /** 寫入失敗時用。沒有它的話暫存會永遠停在一個伺服器不同意的位置。 */
  const reset = useCallback(() => setPreview(null), []);

  return { start, move, end, boxOf, settle, reset, draggingId: preview?.id ?? null };
}
