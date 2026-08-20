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
    const total = items.reduce((sum, item) => sum + item.quantity, 0);
    const low = items.some((item) => item.quantity < item.minStock);

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

    // 總件數：印出來之後最常被遠遠看一眼的就是這個數字，所以放最大。
    const totalSize = Math.max(13, Math.min(24, height * 0.2));
    context.textBaseline = "bottom";
    context.font = font(totalSize, 700);
    // 「件」要接在數字後面，所以寬度要用**大字型**量——換成小字型再量會短一截，
    // 單位就疊到數字上。
    const totalText = fit(context, total.toLocaleString("zh-TW"), width - padding * 2 - 20);
    const totalWidth = context.measureText(totalText).width;
    context.fillText(totalText, x + padding, y + height - padding);
    context.font = font(Math.max(8, totalSize * 0.5), 400);
    context.fillText("件", x + padding + totalWidth + 3, y + height - padding);

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
