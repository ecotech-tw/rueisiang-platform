import liff from "@line/liff";

const liffId = import.meta.env.VITE_LIFF_ID?.trim() ?? "";
let initPromise: Promise<void> | null = null;
let initialized = false;

export function isLiffConfigured(): boolean {
  return Boolean(liffId);
}

export async function initializeLiff(): Promise<void> {
  // isInClient 可在 init 前呼叫；一般 HR 瀏覽器不應依賴 LINE 服務才能啟動。
  if (!liffId || !liff.isInClient() || initialized) return;
  if (!initPromise) {
    initPromise = liff.init({ liffId }).then(() => {
      initialized = true;
    }).catch((error: unknown) => {
      initPromise = null;
      throw error;
    });
  }
  await initPromise;
}

/** 不回傳 profile；伺服器只接受 ID token 並向 LINE 驗證其 subject。 */
export function getLiffIdToken(): string | null {
  if (!liffId || !initialized || !liff.isInClient()) return null;
  if (!liff.isLoggedIn()) throw new Error("請先在 LINE 中完成登入，再使用 HR 打卡。");
  const token = liff.getIDToken();
  if (!token) throw new Error("LINE 未提供身分驗證憑證，請確認 LIFF 已啟用 openid 權限並重新開啟。");
  return token;
}
