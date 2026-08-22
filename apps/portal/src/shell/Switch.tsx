/**
 * Material 3 的 Switch：膠囊軌道 ＋ 圓形滑塊，開啟時滑塊變大並帶一個勾。
 *
 * 用在「切了就生效」的設定，不要用在需要按儲存才送出的表單——M3 的 switch 語意就是
 * 立即生效，長得像開關卻要再按一次儲存會騙到人。要收在表單裡送出的用 checkbox。
 *
 * 底下是真的 <input type="checkbox">，所以鍵盤、螢幕閱讀器與表單語意都照舊；外觀
 * 全部畫在旁邊的 <span> 上。
 */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  busy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** 給螢幕閱讀器用的說明；畫面上的文字由呼叫端自己排。 */
  label: string;
  /** 儲存中。仍然看得出目前狀態，但擋住連點。 */
  busy?: boolean;
}) {
  return (
    <span className={`m3-switch${busy ? " is-busy" : ""}`}>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled || busy}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="m3-switch-track" aria-hidden="true">
        <span className="m3-switch-thumb">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" />
          </svg>
        </span>
      </span>
    </span>
  );
}
