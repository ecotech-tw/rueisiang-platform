import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 地圖的縮放與全螢幕。
 *
 * 畫布用**像素**尺寸（canvasWidth × canvasHeight）加上 transform: scale，不是
 * 「百分比寬度 ＋ aspect-ratio」。差別在於倉位方塊有固定的像素大小，所以
 * 「這個方塊放得下幾個層架」才算得出來——用流動寬度的話那個答案會隨視窗變，
 * 每次縮視窗層架就重排一次。
 */

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;

export function useMapViewport(canvasWidth: number) {
  const [zoom, setZoom] = useState(1);
  /** 只在第一次載入時自動縮放。之後使用者調過就不要再幫他決定。 */
  const fitted = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);

  /**
   * 縮放時以某個點為錨。
   *
   * 沒有這個的話，畫面永遠往左上角縮——使用者正在看的那一區會跑掉，要再捲回來找。
   * 作法是：先算出錨點在畫布座標上是哪裡，縮完再把捲動位置調回去讓它留在原處。
   */
  const zoomTo = useCallback(
    (requested: number, clientX?: number, clientY?: number) => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, requested));
      const scroller = scrollRef.current;
      if (!scroller || next === zoom) {
        setZoom(next);
        return;
      }

      const rect = scroller.getBoundingClientRect();
      const anchorX = clientX === undefined ? scroller.clientWidth / 2 : clientX - rect.left;
      const anchorY = clientY === undefined ? scroller.clientHeight / 2 : clientY - rect.top;
      const canvasX = (scroller.scrollLeft + anchorX) / zoom;
      const canvasY = (scroller.scrollTop + anchorY) / zoom;

      setZoom(next);
      // 等 React 把新的尺寸畫上去再調捲動位置，不然算到的是舊的 scrollWidth。
      requestAnimationFrame(() => {
        scroller.scrollLeft = canvasX * next - anchorX;
        scroller.scrollTop = canvasY * next - anchorY;
      });
    },
    [zoom],
  );

  /**
   * 第一次載入時縮到剛好放得下整張圖的寬度。
   *
   * 手機上不做的話，1600px 的畫布在 350px 的視窗裡是 100%——一次只看得到五分之一
   * 張圖，而且沒有任何線索告訴你其他部分在右邊。地圖的價值就是「一眼看完」，
   * 打開就得先捲半天等於沒有地圖。
   *
   * 桌機放得下就維持 100%：不要把本來就剛好的東西放大。
   */
  useEffect(() => {
    const scroller = scrollRef.current;
    if (fitted.current || !scroller || !canvasWidth) return;
    /*
     * clientWidth 含內距，但內距是刻意留給浮動按鈕的空白，不能拿來放地圖。
     * 不扣掉的話算出來的比例會比真正放得下的大，右邊就多一條捲軸。
     */
    const style = getComputedStyle(scroller);
    const available =
      scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (available <= 0) return;
    fitted.current = true;
    /*
     * 無條件捨去到 5% 的刻度，不是四捨五入。進位的話算出來的比例會比實際可用的
     * 寬度大一點點（1348px 的視窗算成 85% ＝ 1360px），底下就多一條只能捲幾像素
     * 的捲軸——那種捲軸看起來像壞掉。
     */
    const fit = available / canvasWidth;
    if (fit < 1) setZoom(Math.max(0.5, Math.floor(fit * 20) / 20));
  }, [canvasWidth]);

  /**
   * Ctrl/⌘ ＋ 滾輪縮放。
   *
   * 用原生事件而不是 React 的 onWheel：React 的 wheel 監聽是 passive 的，
   * preventDefault 會被忽略，於是瀏覽器仍然執行自己的頁面縮放。
   */
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      // 指數而不是線性：每一格滾動的縮放「感覺」才一致，不會越放大越跳。
      zoomTo(zoom * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [zoom, zoomTo]);

  /** 雙指捏合。手機上沒有 Ctrl 可以按，這是唯一的縮放手勢。 */
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);

  const onTouchStart = useCallback(
    (event: React.TouchEvent) => {
      if (event.touches.length !== 2) return;
      const [a, b] = [event.touches[0]!, event.touches[1]!];
      pinch.current = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom };
    },
    [zoom],
  );

  const onTouchMove = useCallback(
    (event: React.TouchEvent) => {
      if (event.touches.length !== 2 || !pinch.current) return;
      const [a, b] = [event.touches[0]!, event.touches[1]!];
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      zoomTo(
        (pinch.current.zoom * distance) / pinch.current.distance,
        (a.clientX + b.clientX) / 2,
        (a.clientY + b.clientY) / 2,
      );
    },
    [zoomTo],
  );

  const onTouchEnd = useCallback((event: React.TouchEvent) => {
    if (event.touches.length < 2) pinch.current = null;
  }, []);

  /*
   * 全螢幕。狀態要跟著瀏覽器走而不是自己記：使用者按 Esc 或 F11 離開時
   * 不會經過我們的按鈕，只記自己的話按鈕就會顯示錯的狀態。
   */
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const root = rootRef.current;
    if (!root) return;
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen();
      else await root.requestFullscreen();
    } catch {
      // iOS Safari 的 <div> 進不了全螢幕。按鈕沒反應好過整頁壞掉。
    }
  }, []);

  return {
    zoom,
    zoomTo,
    scrollRef,
    rootRef,
    fullscreen,
    toggleFullscreen,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    canZoomIn: zoom < MAX_ZOOM,
    canZoomOut: zoom > MIN_ZOOM,
  };
}
