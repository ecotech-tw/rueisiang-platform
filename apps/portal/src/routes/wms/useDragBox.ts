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
 * 在前端也夾一次不是不信任後端，是為了讓拖曳「拖不出去」——只靠後端夾的話，
 * 方塊會跟著滑鼠跑到畫布外，放開之後才彈回來。
 */
const BOUNDS = {
  x: { min: 0, max: 92 },
  y: { min: 0, max: 92 },
  width: { min: 8, max: 42 },
  height: { min: 8, max: 38 },
} as const;

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
export function useDragBox(onCommit: (id: string, box: Partial<Box>) => void) {
  const state = useRef<DragState | null>(null);
  /** 拖曳中的暫時位置。只有這一個方塊會偏離伺服器上的值。 */
  const [preview, setPreview] = useState<{ id: string; box: Box } | null>(null);

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
        moved: false,
      };
      setPreview({ id, box });
    },
    [],
  );

  const move = useCallback((event: React.PointerEvent) => {
    const current = state.current;
    if (!current) return;

    const dx = event.clientX - current.pointerX;
    const dy = event.clientY - current.pointerY;
    if (!current.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
    current.moved = true;

    // 像素換成百分比：畫布多大都一樣，縮放視窗不會讓拖曳的比例跑掉。
    const percentX = (dx / current.canvasWidth) * 100;
    const percentY = (dy / current.canvasHeight) * 100;
    const { origin } = current;

    const box: Box =
      current.mode === "move"
        ? {
            ...origin,
            x: clamp(origin.x + percentX, BOUNDS.x),
            y: clamp(origin.y + percentY, BOUNDS.y),
          }
        : {
            ...origin,
            width: clamp(origin.width + percentX, BOUNDS.width),
            height: clamp(origin.height + percentY, BOUNDS.height),
          };

    setPreview({ id: current.id, box });
  }, []);

  /** 回傳 true 代表這是一次拖曳，呼叫端就不該再把它當成點擊。 */
  const end = useCallback(
    (event: React.PointerEvent): boolean => {
      const current = state.current;
      state.current = null;
      setPreview(null);
      if (!current) return false;

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!current.moved) return false;

      const dx = event.clientX - current.pointerX;
      const dy = event.clientY - current.pointerY;
      const percentX = (dx / current.canvasWidth) * 100;
      const percentY = (dy / current.canvasHeight) * 100;
      const { origin } = current;

      /*
       * 只送真的改了的那兩個欄位。整包送的話，後端會把「當下畫面上的值」全部
       * 寫回去，包含別人剛改過的名稱或層架。
       */
      if (current.mode === "move") {
        onCommit(current.id, {
          x: clamp(origin.x + percentX, BOUNDS.x),
          y: clamp(origin.y + percentY, BOUNDS.y),
        });
      } else {
        onCommit(current.id, {
          width: clamp(origin.width + percentX, BOUNDS.width),
          height: clamp(origin.height + percentY, BOUNDS.height),
        });
      }
      return true;
    },
    [onCommit],
  );

  /** 這個方塊此刻該畫在哪。拖曳中的用暫時值，其他的用伺服器上的值。 */
  const boxOf = useCallback(
    (id: string, box: Box): Box => (preview?.id === id ? preview.box : box),
    [preview],
  );

  return { start, move, end, boxOf, draggingId: preview?.id ?? null };
}
