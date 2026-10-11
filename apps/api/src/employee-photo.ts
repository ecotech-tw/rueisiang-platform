import { HR_EMPLOYEE_PHOTO_MAX_BYTES, HR_EMPLOYEE_PHOTO_MAX_PIXELS, HR_EMPLOYEE_PHOTO_MAX_SIDE, HR_EMPLOYEE_PHOTO_TYPES } from "@rueisiang/db/hr-profile-fields";
import { HTTPException } from "hono/http-exception";
import { ImageError, MemorySource } from "purejsimage/browser";
import { jpegCodec } from "purejsimage/codecs/jpeg";
import { pngCodec } from "purejsimage/codecs/png";
import { webpCodec } from "purejsimage/codecs/webp";

// 只載入三種純 JS codec，不依賴 Node、原生套件或 WASM；避免自行維護安全敏感的解碼器。
const codecs = { "image/jpeg": jpegCodec, "image/png": pngCodec, "image/webp": webpCodec };
const limits = { maxInputBytes: HR_EMPLOYEE_PHOTO_MAX_BYTES, maxPixels: HR_EMPLOYEE_PHOTO_MAX_PIXELS, maxWidth: HR_EMPLOYEE_PHOTO_MAX_SIDE, maxHeight: HR_EMPLOYEE_PHOTO_MAX_SIDE, maxDecodedBytes: 32 * 1024 * 1024, maxFrames: 1 };

// 只辨識 JPEG header 內的 MPF APP2，不解析像素；畸形結構仍交由完整 codec 驗證。
// library 會忽略超過 1000 的 MPF 影像數，因此不支援 MPF/MPO，不能只相信 metadata.frames。
function hasJpegMpf(bytes: Uint8Array) {
  if (!jpegCodec.detect(bytes)) return false;
  let position = 2;
  while (position < bytes.length) {
    if (bytes[position++] !== 0xff) break;
    while (bytes[position] === 0xff) position++;
    const marker = bytes[position++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (position + 2 > bytes.length) break;
    const length = (bytes[position]! << 8) | bytes[position + 1]!;
    if (length < 2 || position + length > bytes.length) break;
    if (marker === 0xe2 && length >= 6 && bytes[position + 2] === 0x4d && bytes[position + 3] === 0x50 && bytes[position + 4] === 0x46 && bytes[position + 5] === 0) return true;
    position += length;
  }
  return false;
}

export async function validateEmployeePhoto(bytes: Uint8Array, contentType: string) {
  const type = HR_EMPLOYEE_PHOTO_TYPES.find((value) => value === contentType);
  if (!type || bytes.length === 0 || bytes.length > limits.maxInputBytes) throw new HTTPException(400, { message: "只能上傳 5 MB 以內的 JPEG、PNG 或 WebP 靜態照片。" });
  const codec = codecs[type];
  if (type === "image/jpeg" && hasJpegMpf(bytes)) throw new HTTPException(400, { message: "大頭貼不支援 MPF／MPO 多影像 JPEG，請另存成單張圖片後再上傳。" });
  try {
    if (!codec.detect(bytes) || !codec.createDecoder) throw new Error("invalid image");
    const source = new MemorySource(bytes);
    const metadata = await codec.metadata(source, limits);
    // decoder 可能只處理選定影像；先核對容器的影像數，不能只依賴 decoder 的 limits。
    if ((metadata.frames ?? 1) > limits.maxFrames) throw new ImageError("LIMIT_EXCEEDED", "Employee photos must contain one frame");
    const decoder = await codec.createDecoder(source, limits, { tolerantDecoding: false });
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
