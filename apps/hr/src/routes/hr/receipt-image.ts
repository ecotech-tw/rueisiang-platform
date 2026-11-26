import { EXPENSE_RECEIPT_UPLOAD_SIDE } from "@rueisiang/db/accounting-expense-fields";

/*
 * 手機拍的發票常常是 1200 萬像素、好幾 MB，直接上傳會超過伺服器的上限，在行動網路上也很慢。
 * 送出前在瀏覽器縮到 EXPENSE_RECEIPT_UPLOAD_SIDE 並重新存成 JPEG：發票上的字仍然看得清楚，
 * 一張大約幾百 KB。重新編碼也順便把 iPhone 的 HEIC、多影像 JPEG 變成伺服器收得下的單張 JPEG。
 */
export async function prepareReceiptImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, EXPENSE_RECEIPT_UPLOAD_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    // JPEG 沒有透明；PNG 截圖的透明處補白，不然會變成黑底。
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error("encode failed");
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "receipt"}.jpg`, { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}
