import { HR_EMPLOYEE_PHOTO_MAX_BYTES, HR_EMPLOYEE_PHOTO_MAX_PIXELS, HR_EMPLOYEE_PHOTO_MAX_SIDE, HR_EMPLOYEE_PHOTO_TYPES } from "@rueisiang/db/hr-profile-fields";
import { HTTPException } from "hono/http-exception";
import { ImageError, MemorySource } from "purejsimage/browser";
import { jpegCodec } from "purejsimage/codecs/jpeg";
import { pngCodec } from "purejsimage/codecs/png";
import { webpCodec } from "purejsimage/codecs/webp";

// 只載入三種純 JS codec，不依賴 Node、原生套件或 WASM；避免自行維護安全敏感的解碼器。
const codecs = { "image/jpeg": jpegCodec, "image/png": pngCodec, "image/webp": webpCodec };
const limits = { maxInputBytes: HR_EMPLOYEE_PHOTO_MAX_BYTES, maxPixels: HR_EMPLOYEE_PHOTO_MAX_PIXELS, maxWidth: HR_EMPLOYEE_PHOTO_MAX_SIDE, maxHeight: HR_EMPLOYEE_PHOTO_MAX_SIDE, maxDecodedBytes: 32 * 1024 * 1024, maxFrames: 1 };

export async function validateEmployeePhoto(bytes: Uint8Array, contentType: string) {
  const type = HR_EMPLOYEE_PHOTO_TYPES.find((value) => value === contentType);
  if (!type || bytes.length === 0 || bytes.length > limits.maxInputBytes) throw new HTTPException(400, { message: "只能上傳 5 MB 以內的 JPEG、PNG 或 WebP 靜態照片。" });
  const codec = codecs[type];
  try {
    if (!codec.detect(bytes) || !codec.createDecoder) throw new Error("invalid image");
    const decoder = await codec.createDecoder(new MemorySource(bytes), limits, { tolerantDecoding: false });
    let rows = 0;
    // metadata 與 magic 都不能證明像素可解碼；消耗完整串流，但不保留整張圖的像素副本。
    for await (const block of decoder.decode()) {
      try { rows += block.height; }
      finally { block.release?.(); }
    }
    if (rows !== decoder.height) throw new Error("incomplete image");
    return type;
  } catch (error) {
    throw new HTTPException(400, { message: error instanceof ImageError && error.code === "LIMIT_EXCEEDED" ? "照片超出解碼限制；請使用 800 萬像素、單邊 8192 px 以內的靜態圖片。" : "照片損壞或無法解碼，請重新選擇有效的 JPEG、PNG 或 WebP 圖片。" });
  }
}
