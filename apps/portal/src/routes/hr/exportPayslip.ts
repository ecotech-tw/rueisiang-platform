import { toBlob } from "html-to-image";

const EXPORT_PIXEL_RATIO = 2;

function filePart(value: string, fallback: string): string {
  const part = value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, "-");
  return part || fallback;
}

/**
 * 直接重用預覽 DOM，避免 PNG 另外維護一套薪資條排版；下載內容會和使用者眼前看到的紙張一致。
 */
export async function downloadPayslipImage(element: HTMLElement, personName: string, periodKey: string): Promise<void> {
  const blob = await toBlob(element, {
    backgroundColor: "#ffffff",
    cacheBust: true,
    pixelRatio: EXPORT_PIXEL_RATIO,
    // 預覽紙張在 Dialog 外要留 36px，但 PNG 不應把這段操作介面留白一起帶出去。
    style: { margin: "0" },
  });
  if (!blob) throw new Error("圖片產生失敗，請再試一次。");

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `薪資條-${filePart(personName, "員工")}-${filePart(periodKey, "期間")}.png`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
