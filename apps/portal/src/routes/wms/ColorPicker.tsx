import { useId, type CSSProperties } from "react";
import { WAREHOUSE_CATEGORY_COLORS } from "./api.js";

/**
 * 一排色票：倉儲分類、品項分類、倉位、地圖標籤共用。
 *
 * 底層是一組 radio，不是自己刻的 div：鍵盤的左右鍵本來就會在同一組 radio 之間
 * 移動，螢幕閱讀器也會念出「10 個裡的第 3 個」。真正的 input 用 opacity 藏起來
 * （不是 display: none——那會讓它拿不到焦點），外面那個 label 才是看得到的圓點。
 *
 * 十顆色票永遠排成一行。折成兩行的話會看起來像兩組不同的色，而它們是一組。
 * 用十欄的 grid 而不是 flex ＋ 固定尺寸：固定尺寸就要去算「幾 px 乘十再加間距
 * 塞不塞得下」，而那個寬度隨對話框、隨螢幕、隨字級變。試過 26px 與 28px，
 * 兩次都在某個寬度下折行。讓格線決定大小，色票跟著縮就不必算了。
 * 寬的地方也不要把它們拉成十顆巨大的圓，所以最寬 360px。
 */
export function ColorPicker({ value, onChange, label }: { value: string; onChange: (color: string) => void; label: string }) {
  // 同一頁可能同時開著兩組（例如地圖上的倉位與標籤），radio 的 name 不能撞。
  const name = useId();
  return (
    <div className="grid max-w-[360px] grid-cols-[repeat(10,1fr)] gap-2" role="radiogroup" aria-label={label}>
      {WAREHOUSE_CATEGORY_COLORS.map((color) => (
        <label
          key={color}
          style={{ "--swatch": `var(--color-tone-${color})` } as CSSProperties}
          /*
           * 未選中只有一圈很淡的內框，讓淺色的色票在白底上也看得出邊界。
           * 選中是外面一圈同色的環、中間留白：Material 的選中是「安靜地成立」，
           * 換成更亮的顏色的話，被選中的那一顆就不再是它代表的顏色了。
           */
          className={`relative aspect-square w-full cursor-pointer rounded-[50%] bg-(--swatch) text-(--swatch) has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-secondary ${value === color ? "[box-shadow:0_0_0_2px_var(--color-paper)_inset,0_0_0_4px_currentColor_inset]" : "[box-shadow:inset_0_0_0_1px_--alpha(var(--color-ink)/12%)]"}`}
        >
          <input type="radio" className="absolute inset-0 m-0 cursor-pointer opacity-0" name={name} value={color} checked={value === color} onChange={() => onChange(color)} />
          {/* 顏色本身對看不到顏色的人沒有意義，用名字補上。 */}
          <span className="sr-only">{color}</span>
        </label>
      ))}
    </div>
  );
}
