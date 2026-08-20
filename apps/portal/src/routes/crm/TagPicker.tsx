import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../shell/icons.js";

/** 下拉浮在畫面上的位置。用 fixed，所以直接是視窗座標，不必自己扣捲動位移。 */
interface DropdownBox {
  left: number;
  width: number;
  /** 往下開就給 top，往上開就給 bottom——空間不夠時要能翻面。 */
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/** 下拉與輸入框之間的距離，以及離視窗邊緣至少要留的空白。 */
const GAP = 4;
const EDGE = 12;

function measure(anchor: HTMLElement): DropdownBox {
  const rect = anchor.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;

  /*
   * 預設往下開；下面塞不下、而上面比較寬敞時才翻上去。用「比較」而不是固定
   * 門檻：在矮的手機視窗上兩邊都不夠，這時要選比較不糟的那一邊。
   */
  const flip = below < 180 && above > below;
  return {
    left: rect.left,
    width: rect.width,
    ...(flip ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
    maxHeight: Math.max(120, Math.min(260, flip ? above : below)),
  };
}

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

  const [box, setBox] = useState<DropdownBox | null>(null);

  const reposition = useCallback(() => {
    if (comboRef.current) setBox(measure(comboRef.current));
  }, []);

  /*
   * 用 layout effect 先算好位置再讓瀏覽器畫，不然會先在左上角閃一下。
   * 跟著 matches 一起重算：選項數量變了，能不能塞在下面的答案也會變。
   */
  useLayoutEffect(() => {
    if (open) reposition();
    else setBox(null);
  }, [open, matches.length, value.length, reposition]);

  /*
   * 對話框自己會捲，所以 scroll 要用 capture 才聽得到——事件不會冒泡到 window。
   * 不重新定位的話，捲一下下拉就跟輸入框分家了。
   */
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition]);


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

      </div>

      {/*
        * 下拉用 portal 掛到 body，fixed 定位。
        *
        * 留在原地的話會被 .modal-card 的 overflow: hidden 裁掉（選項看得到卻
        * 點不到）；改成在流內展開又會把表單推長、讓對話框長出捲軸——那是使用者
        * 回報「很奇怪」的那一版。掛到 body 兩個問題都沒有：它浮在最上層，
        * 表單的高度完全不受影響。
        */}
      {open && box && (matches.length > 0 || (term && !exact))
        ? createPortal(
            <ul
              className="tag-options"
              ref={listRef}
              style={{
                left: box.left,
                width: box.width,
                maxHeight: box.maxHeight,
                ...(box.top !== undefined ? { top: box.top } : { bottom: box.bottom }),
              }}
              /* 按下去不要讓輸入框失焦，不然 blur 會在 click 之前把清單收掉。 */
              onMouseDown={(event) => event.preventDefault()}
            >
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
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
