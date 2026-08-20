import { useMemo, useRef, useState } from "react";
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
        <ul className="tag-options">
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
  );
}
