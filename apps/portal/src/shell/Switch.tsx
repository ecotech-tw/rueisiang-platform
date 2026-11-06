/**
 * Material 3 的 Switch：膠囊軌道 ＋ 圓形滑塊，開啟時滑塊變大並帶一個勾。
 *
 * 用在「切了就生效」的設定，不要用在需要按儲存才送出的表單——M3 的 switch 語意就是
 * 立即生效，長得像開關卻要再按一次儲存會騙到人。要收在表單裡送出的用 checkbox。
 *
 * 底下是真的 <input type="checkbox">，所以鍵盤、螢幕閱讀器與表單語意都照舊；外觀
 * 全部畫在旁邊的 <span> 上。
 *
 * 規格：軌道 52×32、滑塊關閉 16px／開啟 24px。滑塊變大是 M3 用來表達「已開啟」的
 * 主要訊號，不是裝飾——只換顏色的話色弱使用者分不出兩個狀態。
 */
const MOTION = "duration-150 ease-out motion-reduce:transition-none";

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
  const off = Boolean(disabled || busy);
  /*
   * 開關狀態直接看 props，不用 peer-checked：滑塊與勾勾在軌道裡面，要從 input 的兄弟再往下找，
   * 寫成 variant 反而難讀。input 疊在整顆上面，滑過任何一處都是滑過 input，所以 hover 用 group。
   * hover 是 state layer：在原本的底色上疊一層品牌色，不是換一個顏色。
   */
  const track = checked
    ? `border-brand bg-brand ${off ? "" : "group-hover:bg-brand-dark"}`
    : `border-muted bg-canvas ${off ? "" : "group-hover:bg-brand/7"}`;
  return (
    <span className={`group relative inline-flex flex-none ${busy ? "opacity-60" : ""}`}>
      <input
        type="checkbox"
        role="switch"
        className="peer absolute inset-0 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        aria-label={label}
        checked={checked}
        disabled={off}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        className={`inline-flex h-8 w-[52px] items-center rounded-full border-2 px-0.5 transition-[background-color,border-color] ${MOTION} peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand ${track} ${off ? "opacity-38" : ""}`}
        aria-hidden="true"
      >
        <span className={`grid flex-none place-items-center rounded-full transition-[width,height,margin,background-color,color] ${MOTION} ${checked ? "mr-0 ml-5 size-6 bg-paper text-brand-dark" : "ml-1 size-4 bg-muted text-transparent"}`}>
          <svg className={`size-3.5 transition-opacity ${MOTION} ${checked ? "opacity-100" : "opacity-0"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" />
          </svg>
        </span>
      </span>
    </span>
  );
}
