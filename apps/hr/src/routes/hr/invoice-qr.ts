/*
 * 電子發票證明聯左邊的 QR code。財政部規格的前 53 字依序是：
 *
 *   發票號碼 10｜開立日期 7（民國年 yyyMMdd）｜隨機碼 4｜銷售額 8（十六進位、未稅）｜
 *   總計額 8（十六進位、含稅）｜買方統編 8｜賣方統編 8
 *
 * 後面還有加密驗證與品項明細，報帳用不到。右邊那個 QR 以「**」開頭，只有品項，沒有號碼與金額。
 * 手開的二聯、三聯式發票與收據沒有 QR code，讀不到就讓使用者照舊手填。
 */

export interface InvoiceQrFields {
  invoiceNumber: string;
  spentOn: string;
  /** 總計額（含稅），整數元。 */
  amountDollars: number;
  sellerTaxId: string;
}

const LEFT_QR = /^([A-Z]{2}\d{8})(\d{3})(\d{2})(\d{2})\d{4}[0-9A-Fa-f]{8}([0-9A-Fa-f]{8})\d{8}(\d{8})/;

export function parseInvoiceQr(text: string): InvoiceQrFields | null {
  const match = LEFT_QR.exec(text.trim());
  if (!match) return null;
  const [, invoiceNumber, rocYear, month, day, totalHex, sellerTaxId] = match as unknown as [string, string, string, string, string, string, string];
  const year = Number(rocYear) + 1911;
  const date = new Date(Date.UTC(year, Number(month) - 1, Number(day)));
  const spentOn = `${year}-${month}-${day}`;
  // 2 月 30 日這種會被 Date 滾到下個月；滾過去就代表不是有效日期。
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== spentOn) return null;
  const amountDollars = Number.parseInt(totalHex, 16);
  if (!Number.isSafeInteger(amountDollars) || amountDollars < 1) return null;
  return { invoiceNumber, spentOn, amountDollars, sellerTaxId };
}

/** 一張照片裡讀到好幾個 QR code 時，挑出證明聯左邊那個（右邊那個以「**」開頭，parse 不會過）。 */
export function pickInvoiceFields(texts: readonly string[]): InvoiceQrFields | null {
  for (const text of texts) {
    const fields = parseInvoiceQr(text);
    if (fields) return fields;
  }
  return null;
}

/*
 * 整張照片先縮到長邊 2000 讀一次；經過 canvas 也順便處理 iPhone 的 HEIC 與照片的 EXIF 方向。
 *
 * 左邊那個 QR 塞了號碼、金額、加密驗證與品項，格子很密，感熱紙的黑點又會往旁邊暈開；實際拍的證明聯
 * 整張讀時常常只讀到右邊那個。能不能讀到很看縮放比例與黑白切法（同一張照片 0.6、0.75 倍讀得到，
 * 0.67 倍就讀不到），沒有一個固定設定每張都行，所以：
 *
 *   1. 整張讀到的 QR code 告訴我們 QR 在照片的哪一段高度，切出那一條（左右兩個 QR 一定在同一列）。
 *   2. 那一條換幾種縮放、兩種黑白切法輪流讀，讀到左邊那個就停。條狀圖很小，每次只要幾十毫秒。
 */
const BASE_SIDE = 2000;
const BAND_SCALES = [1, 0.75, 0.6, 0.85, 1.25, 1.5, 0.5];
const BINARIZERS = ["LocalAverage", "FixedThreshold"] as const;
/** 放大後的條狀圖最多這麼多像素，避免舊手機記憶體不夠。 */
const MAX_ATTEMPT_PIXELS = 6_000_000;

interface Rect { x: number; y: number; width: number; height: number }

function drawRegion(bitmap: ImageBitmap, rect: Rect, scale: number): ImageData | null {
  const fit = Math.min(scale, Math.sqrt(MAX_ATTEMPT_PIXELS / (rect.width * rect.height)));
  const width = Math.max(1, Math.round(rect.width * fit));
  const height = Math.max(1, Math.round(rect.height * fit));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

export async function scanInvoiceQr(file: Blob): Promise<InvoiceQrFields | null> {
  const [{ readQrCodes }, bitmap] = await Promise.all([
    import("./invoice-qr-reader.js"),
    createImageBitmap(file, { imageOrientation: "from-image" }),
  ]);
  try {
    const whole: Rect = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
    const base = Math.min(1, BASE_SIDE / Math.max(bitmap.width, bitmap.height));
    const firstImage = drawRegion(bitmap, whole, base);
    if (!firstImage) return null;
    const first = await readQrCodes(firstImage, "LocalAverage");
    const seen = first.map((code) => code.text);
    let fields = pickInvoiceFields(seen);
    if (fields) return fields;

    let band = whole;
    if (first.length) {
      const top = Math.min(...first.map((code) => code.top)) / base;
      const bottom = Math.max(...first.map((code) => code.bottom)) / base;
      const margin = (bottom - top) * 0.35;
      const y = Math.max(0, Math.floor(top - margin));
      band = { x: 0, y, width: bitmap.width, height: Math.min(bitmap.height, Math.ceil(bottom + margin)) - y };
    }
    for (const scale of BAND_SCALES) {
      for (const binarizer of BINARIZERS) {
        // 整張用預設切法讀過了；沒找到任何 QR 時，條狀圖就是整張，這一輪不必重讀。
        if (!first.length && scale === 1 && binarizer === "LocalAverage") continue;
        const image = drawRegion(bitmap, band, base * scale);
        if (!image) return null;
        const codes = await readQrCodes(image, binarizer);
        seen.push(...codes.map((code) => code.text));
        fields = pickInvoiceFields(codes.map((code) => code.text));
        if (fields) return fields;
      }
    }
    // 只讀到右邊（**）那個就當作沒讀到；讀到別種 QR code 才把開頭講出來，回報時知道是格式問題。
    const others = [...new Set(seen.filter((text) => !text.startsWith("**")))];
    if (others.length) throw new Error(`讀到 QR code 但不是電子發票格式：${others.map((text) => text.slice(0, 20)).join("／")}`);
    return null;
  } finally {
    bitmap.close();
  }
}
