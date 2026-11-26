import { prepareZXingModule, readBarcodes, type ReaderOptions } from "zxing-wasm/reader";
import zxingReaderWasm from "zxing-wasm/reader/zxing_reader.wasm?url";

/*
 * ZXing 的解碼器（WASM）。只由 invoice-qr.ts 動態載入，不進打卡等頁面的主程式。
 *
 * 不用 jsQR：jsQR 一次只回一個 QR code，證明聯左右兩個 QR 靠得很近，實測整張拍時它只讀得到右邊那個
 * （只有品項），左邊有號碼與金額的那個怎麼裁切都讀不到。ZXing 一次回傳畫面裡所有的 QR code。
 *
 * WASM 檔由 Vite 打包成自己的靜態檔；套件預設會去 jsDelivr 抓，正式環境不該依賴外部 CDN。
 */
prepareZXingModule({
  overrides: { locateFile: (path: string, prefix: string) => path.endsWith(".wasm") ? zxingReaderWasm : prefix + path },
});

export type QrBinarizer = NonNullable<ReaderOptions["binarizer"]>;
export interface QrCode { text: string; top: number; bottom: number }

export async function readQrCodes(image: ImageData, binarizer: QrBinarizer): Promise<QrCode[]> {
  const results = await readBarcodes(image, { formats: ["QRCode"], tryHarder: true, maxNumberOfSymbols: 4, binarizer });
  return results.filter((result) => result.isValid).map((result) => {
    const ys = [result.position.topLeft.y, result.position.topRight.y, result.position.bottomLeft.y, result.position.bottomRight.y];
    return { text: result.text, top: Math.min(...ys), bottom: Math.max(...ys) };
  });
}
