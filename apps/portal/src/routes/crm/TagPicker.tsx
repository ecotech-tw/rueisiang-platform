import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../shell/icons.js";

/**
 * 標籤選擇器。輸入時從既有標籤裡過濾，沒有符合的就按 Enter 新增一個。
 *
 * 原本是一個空白輸入框加一顆「新增」——打字的人看不到公司已經有哪些標籤，
 * 於是「需追蹤」「待追蹤」「要追蹤」會同時存在。有搜尋之後，先看到既有的、
 * 找不到才新開一個，這才是標籤該有的行為。
 */
export function TagPicker({
  value,
  options,
  onChange,
}: {
  value: string[];
  /** 目前系統裡已經有的標籤（含使用次數，用來排序）。 */
  options: { name: string; customerCount: number }[];
  onChange: (tags: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const comboRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);


  const term = input.trim();
  const matches = useMemo(() => {
    const chosen = new Set(value);
    return options
      .filter((option) => !chosen.has(option.name))
      .filter((option) => !term || option.name.includes(term))
      // 常用的排前面：找標籤時最可能要的就是最多人用的那幾個。
      .sort((a, b) => b.customerCount - a.customerCount)
      .slice(0, 8);
  }, [options, term, value]);

  /*
   * 展開時把**清單的底部**捲進可視範圍。
   *
   * 標籤是這張表單的最後一欄，而對話框底部有一條 sticky 的按鈕列。只捲輸入框
   * （block: "nearest"）不夠——輸入框看得到了，但它下面整串選項仍然躲在按鈕列
   * 後面，量出來 8 個選項有 8 個點不到。改捲清單本身、對齊底部，再靠
   * scroll-margin-bottom 讓出按鈕列的高度。
   */
  useEffect(() => {
    if (!open) return;
    /*
     * 等一幀再捲。清單是這一次 render 才長出來的，同一幀就呼叫的話瀏覽器還是
     * 用舊的高度算，捲不到底（實測差 15px，剛好是最後一列露不出來）。
     *
     * behavior 用預設的 instant：捲動只是為了讓選項露出來，不是要給人看動畫，
     * 而 smooth 期間如果使用者已經在打字，畫面會跟著飄。
     */
    const frame = requestAnimationFrame(() => {
      (listRef.current ?? comboRef.current)?.scrollIntoView({ block: "end" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, matches.length]);

  /** 打的字剛好等於某個既有標籤時，不該再提示「新增」——那會建出重複的。 */
  const exact = options.some((option) => option.name === term) || value.includes(term);

  function add(tag: string) {
    const next = tag.trim();
    if (!next || value.includes(next)) return;
    onChange([...value, next]);
    setInput("");
    // 連續加好幾個標籤是常態，焦點留在輸入框。
    inputRef.current?.focus();
  }

  return (
    <div className="field tag-picker">
      <span>標籤</span>

      {value.length ? (
        <div className="chips tight">
          {value.map((tag) => (
            <span className="chip" key={tag}>
              {tag}
              <button
                type="button"
                aria-label={`移除 ${tag}`}
                onClick={() => onChange(value.filter((item) => item !== tag))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/*
        * 下拉在流內展開（不是絕對定位）。這張表單在一個會捲動、而且外層
        * overflow: hidden 的對話框裡——浮起來的下拉一超過卡片底部就被裁掉，
        * 那些選項看得到一半卻點不到。在流內就交給對話框自己捲。
        */}
      <div className="tag-combo" ref={comboRef}>
      <div className="tag-search">
        <Icon name="search" />
        <input
          ref={inputRef}
          aria-label="搜尋或新增標籤"
          placeholder="搜尋標籤，找不到就按 Enter 新增"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          /*
           * 用 blur 延遲關閉而不是 onMouseDown 攔截：延遲夠短感覺不出來，但
           * 足夠讓下拉裡的 click 先跑完。直接在 blur 關掉的話點不到任何選項。
           */
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              // 有完全相同的既有標籤就選它，否則就是新增一個。
              add(term);
            }
            if (event.key === "Escape") setOpen(false);
          }}
        />
      </div>

      {open && (matches.length > 0 || (term && !exact)) ? (
        <ul className="tag-options" ref={listRef}>
          {matches.map((option) => (
            <li key={option.name}>
              <button type="button" onClick={() => add(option.name)}>
                <span>{option.name}</span>
                <small>{option.customerCount}</small>
              </button>
            </li>
          ))}
          {term && !exact ? (
            <li>
              <button type="button" className="tag-create" onClick={() => add(term)}>
                <Icon name="plus" />
                新增標籤「{term}」
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
      </div>
    </div>
  );
}
