import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSignOut, useSession } from "./session.js";
import { usePageTitle } from "../shell/usePageTitle.js";
import { Alert, Button, Panel } from "../ui/index.js";
import { useHrWrite } from "../routes/hr/api.js";

const ACCOUNT_ROW = "grid grid-cols-[90px_minmax(0,1fr)] gap-3 py-3";
const ACCOUNT_VALUE = "m-0 min-w-0 font-bold wrap-anywhere";

export function LiffAccountLinkPage({ replaceExisting = false, intentExpired = false }: { replaceExisting?: boolean; intentExpired?: boolean }) {
  usePageTitle("綁定 LINE 打卡");
  const { user } = useSession();
  const canLink = Boolean(user?.isEmployee || user?.hrSelfServiceKind === "worker");
  const client = useQueryClient();
  const signOut = useSignOut();
  // 先更新登入狀態再讓共用 mutation 重抓 HR，避免成功清除 intent 被誤判為逾時。
  const link = useHrWrite<{ linked: boolean }>({ onSuccess: () => client.invalidateQueries({ queryKey: ["session"] }) });
  const [error, setError] = useState<string | null>(null);
  const [signOutPending, setSignOutPending] = useState(false);

  async function switchAccount() {
    setError(null);
    setSignOutPending(true);
    try {
      await signOut();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登出失敗，請稍後再試。");
      setSignOutPending(false);
    }
  }

  async function confirmLink() {
    setError(null);
    try {
      await link.mutateAsync({ path: "/liff/link", method: "POST", values: { replaceExisting } });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "LINE 綁定失敗，請稍後再試。");
    }
  }

  return <main className="grid min-h-dvh place-items-center p-6">
    <Panel className="grid w-[min(100%,480px)] gap-4 p-[clamp(22px,5vw,36px)]">
      <span className="justify-self-start rounded-full bg-[#06c755] px-2.5 py-[5px] text-[12px] font-extrabold tracking-[.04em] text-white" aria-hidden="true">LINE</span>
      <h1 className="m-0 text-[24px]">綁定 LINE 打卡</h1>
      <p className="m-0 text-muted">確認以下是你的公司 HR 帳號。綁定後，之後從 LINE 開啟即可使用本人 HR 功能，不需要再次輸入密碼。</p>
      {!link.isPending && replaceExisting ? <Alert tone="danger">此平台帳號已綁定另一個 LINE 帳號。繼續後會解除舊綁定，並改綁目前開啟打卡頁的 LINE 帳號。</Alert> : null}
      <dl className="m-0 grid gap-0 border-y border-y-line"><div className={ACCOUNT_ROW}><dt className="text-muted">姓名</dt><dd className={ACCOUNT_VALUE}>{user?.name || "—"}</dd></div><div className={`${ ACCOUNT_ROW } border-t border-t-soft-line`}><dt className="text-muted">登入帳號</dt><dd className={ACCOUNT_VALUE}>{user?.email || "—"}</dd></div></dl>
      {!canLink ? <Alert tone="danger">此帳號尚未指派為在職員工，無法使用 LINE 打卡。請聯絡 HR 管理者。</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!link.isPending && intentExpired ? <Alert tone="danger">LINE 綁定驗證已逾時，請重新從 LINE 開啟打卡頁。若目前仍在 LINE 打卡頁，可重新載入驗證。</Alert> : null}
      {!link.isPending && intentExpired ? <Button variant="secondary" onClick={() => window.location.reload()}>重新載入驗證</Button> : null}
      <Button size="lg" disabled={intentExpired || !canLink || link.isPending || signOutPending} onClick={() => void confirmLink()}>
        {link.isPending ? "驗證並綁定中…" : replaceExisting ? "解除舊綁定並改綁目前 LINE" : "確認並綁定這個帳號"}
      </Button>
      <Button variant="secondary" disabled={link.isPending || signOutPending} onClick={() => void switchAccount()}>{signOutPending ? "登出中…" : "不是這個帳號？登出後切換"}</Button>
      <small className="text-muted">LINE 身分由伺服器向 LINE 驗證；不會使用前端自行提供的 LINE UID。</small>
    </Panel>
  </main>;
}
