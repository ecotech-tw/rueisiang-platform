import type { InventoryItem, LayoutElement, Zone } from "./api.js";

/**
 * 把地圖畫成一張 PNG 下載。
 *
 * 為什麼要重畫一次而不是截圖 DOM：瀏覽器沒有「把這塊 DOM 存成圖片」的 API，
 * 要嘛引入 html2canvas 這種函式庫（它自己重新實作了一遍 CSS 排版，圓角、陰影、
 * 中文字型常常畫錯），要嘛自己畫。地圖的內容很單純——方塊、文字、幾個數字，
 * 自己畫幾十行就夠了，而且畫出來的東西完全可預期。
 *
 * 用途是列印貼在倉庫牆上，所以用 2 倍解析度輸出。
 */

const SCALE = 2;

/** 從 CSS 變數讀色票，不要在這裡再抄一份十個色碼。 */
function toneColor(color: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--color-tone-${color}`).trim();
  return value || "#55606e";
}

/** 淡底色。canvas 沒有 --alpha()，自己把 hex 轉成 rgba。 */
function softColor(color: string, alpha: number): string {
  const hex = toneColor(color).replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

/** 放不下就截短加省略號。中文沒有空白可以斷，只能量寬度。 */
function fit(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && context.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

export interface ExportInput {
  settings: { canvasWidth: number; canvasHeight: number };
  zones: Zone[];
  layoutElements: LayoutElement[];
  items: InventoryItem[];
}

export async function downloadMapImage(data: ExportInput): Promise<void> {
  const { canvasWidth, canvasHeight } = data.settings;
  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth * SCALE;
  canvas.height = canvasHeight * SCALE;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("這個瀏覽器沒辦法產生圖片。");
  context.scale(SCALE, SCALE);

  // 白底：印出來的紙是白的，用畫面上的米色底會浪費一整張碳粉。
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvasWidth, canvasHeight);

  const font = (size: number, weight = 400) =>
    `${weight} ${size}px "Noto Sans TC", "Microsoft JhengHei", sans-serif`;

  // 標示先畫，倉位疊在上面——跟畫面上的層次一致。
  for (const element of data.layoutElements) {
    const x = (canvasWidth * element.x) / 100;
    const y = (canvasHeight * element.y) / 100;
    const width = (canvasWidth * element.width) / 100;
    const height = (canvasHeight * element.height) / 100;

    context.save();
    roundedRect(context, x, y, width, height, 8);
    context.fillStyle = softColor(element.color, 0.16);
    context.fill();
    context.setLineDash([6, 4]);
    context.strokeStyle = softColor(element.color, 0.55);
    context.stroke();
    context.setLineDash([]);
    context.clip();

    context.fillStyle = toneColor(element.color);
    context.font = font(Math.max(10, Math.min(15, height * 0.28)), 500);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(fit(context, element.label, width - 12), x + width / 2, y + height / 2);
    context.restore();
  }

  for (const zone of data.zones) {
    const x = (canvasWidth * zone.x) / 100;
    const y = (canvasHeight * zone.y) / 100;
    const width = (canvasWidth * zone.width) / 100;
    const height = (canvasHeight * zone.height) / 100;
    const padding = Math.max(6, Math.min(12, width * 0.05));

    const items = data.items.filter((item) => item.zoneId === zone.id);
    const low = items.some((item) => item.quantity < item.minStock);

    /*
     * 依層架順序排，同一層之內照名稱——跟畫面上那張圖一致。印出來貼在倉庫牆上
     * 的人，看到的順序要對得上架上實際由上而下的位置。
     */
    const shelfOrder = new Map(zone.shelfLevels.map((level, index) => [level.id, index]));
    const listed = [...items].sort((a, b) => {
      const left = shelfOrder.get(a.shelfLevel ?? "") ?? Number.MAX_SAFE_INTEGER;
      const right = shelfOrder.get(b.shelfLevel ?? "") ?? Number.MAX_SAFE_INTEGER;
      return left - right || a.name.localeCompare(b.name, "zh-TW");
    });

    context.save();
    roundedRect(context, x, y, width, height, 10);
    context.fillStyle = softColor(zone.color, 0.16);
    context.fill();
    context.strokeStyle = softColor(zone.color, 0.5);
    context.stroke();
    context.clip();

    const ink = toneColor(zone.color);
    context.textAlign = "left";
    context.textBaseline = "top";

    // 代碼
    context.fillStyle = ink;
    context.font = font(Math.max(9, Math.min(13, height * 0.11)), 700);
    const codeSize = Math.max(9, Math.min(13, height * 0.11));
    context.fillText(fit(context, zone.code, width - padding * 2 - (low ? 18 : 0)), x + padding, y + padding);

    // 低庫存的紅點
    if (low) {
      const radius = 7;
      context.beginPath();
      context.arc(x + width - padding - radius, y + padding + radius, radius, 0, Math.PI * 2);
      context.fillStyle = "#d5383b";
      context.fill();
      context.fillStyle = "#ffffff";
      context.font = font(10, 700);
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("!", x + width - padding - radius, y + padding + radius + 0.5);
      context.textAlign = "left";
      context.textBaseline = "top";
    }

    // 名稱
    context.fillStyle = ink;
    context.font = font(Math.max(9, Math.min(13, height * 0.1)), 500);
    context.fillText(fit(context, zone.name, width - padding * 2), x + padding, y + padding + codeSize + 4);

    /*
     * 放了什麼商品，不是放了幾件。
     *
     * 這張圖會被印出來貼在倉庫牆上，看它的人要找的是「那個東西在哪一格」。
     * 數量印在紙上第二天就過期了，反而會被當真。
     */
    const lineSize = Math.max(8, Math.min(11, height * 0.08));
    const lineHeight = lineSize + 3;
    const top = y + padding + codeSize + Math.max(9, Math.min(13, height * 0.1)) + 8;
    const rows = Math.floor((y + height - padding - top) / lineHeight);

    if (rows > 0) {
      const overflowing = listed.length > rows;
      const visible = listed.slice(0, overflowing ? Math.max(0, rows - 1) : rows);

      context.font = font(lineSize, 400);
      context.fillStyle = ink;
      context.globalAlpha = 0.85;
      visible.forEach((item, index) => {
        context.fillText(
          fit(context, item.name, width - padding * 2),
          x + padding,
          top + index * lineHeight,
        );
      });

      const hidden = listed.length - visible.length;
      if (hidden > 0) {
        context.globalAlpha = 0.6;
        context.fillText(
          `還有 ${hidden} 項`,
          x + padding,
          top + visible.length * lineHeight,
        );
      }
      context.globalAlpha = 1;
    }

    context.restore();
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("圖片產生失敗，請再試一次。");

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  link.download = `倉位配置圖-${stamp}.png`;
  link.click();
  // 不釋放的話這個 blob 會一直佔著記憶體，直到整頁被關掉。
  URL.revokeObjectURL(url);
}
