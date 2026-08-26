import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.js";
import { Button } from "../ui/Button.js";

/**
 * 區間選擇器：一次打開一張日曆，點起日再點迄日。
 *
 * 兩個 `<input type="date">` 也能用，但選一段連續的區間要開兩次日曆、各自翻月，
 * 而且看不到兩個日期的相對位置。這裡並排兩個月，選的過程中滑鼠移到哪就預覽到
 * 哪，一眼看得出圈起來的是哪一段。
 *
 * 常用的區間（上個月、這個月、上一季）直接給按鈕——出金表九成的情況就是上個月，
 * 不該還要在日曆上翻。
 */

interface Props {
  start: string;
  end: string;
  onChange: (range: { start: string; end: string }) => void;
  disabled?: boolean;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** 一律用 UTC 算，避免跨時區時 new Date("2026-07-01") 被推成 6/30。 */
function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1));
}

function addMonths(date: Date, count: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
}

function parse(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 某個月的格子：從當月 1 號往前補到週日，湊滿整週。 */
function daysOf(anchor: Date): (Date | null)[] {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const total = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = monthStart(year, month).getUTCDay();

  return [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: total }, (_, index) => new Date(Date.UTC(year, month, index + 1))),
  ];
}

function thisMonth(): Date {
  const now = new Date();
  return monthStart(now.getUTCFullYear(), now.getUTCMonth());
}

function presets(): { label: string; start: string; end: string }[] {
  // 以台北時間的「今天」為準：Worker 與瀏覽器可能在不同時區，但同仁想的是台灣的日期。
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const range = (from: Date, to: Date) => ({ start: iso(from), end: iso(to) });
  const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0));

  return [
    { label: "上個月", ...range(monthStart(year, month - 1), lastDay(year, month - 1)) },
    { label: "這個月", ...range(monthStart(year, month), lastDay(year, month)) },
    { label: "上一季", ...range(monthStart(year, month - 3), lastDay(year, month - 1)) },
  ];
}

function label(start: string, end: string): string {
  if (!start || !end) return "選擇對帳區間";
  // 同一個月就不重複寫年月，「2026-07-01 ~ 31」比整串好讀。
  return start.slice(0, 7) === end.slice(0, 7) ? `${start} ~ ${end.slice(8)}` : `${start} ~ ${end}`;
}

export function DateRangePicker({ start, end, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(() => thisMonth());
  /** 點了起日還沒點迄日的中間狀態。null 代表下一次點擊是「重新開始選」。 */
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 點外面或按 Esc 就收起來。少了這個，日曆會一直擋著下面的東西。
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function pick(value: string) {
    if (pendingStart === null) {
      setPendingStart(value);
      return;
    }
    // 倒著選也接受——先點 20 號再點 5 號，就是 5 到 20，不要叫人重來。
    const [from, to] = pendingStart <= value ? [pendingStart, value] : [value, pendingStart];
    setPendingStart(null);
    setHovered(null);
    setOpen(false);
    onChange({ start: from, end: to });
  }

  /** 選到一半時，用滑鼠所在位置預覽；否則就是已經確定的區間。 */
  const preview = pendingStart
    ? [pendingStart, hovered ?? pendingStart].sort()
    : [start, end];
  const [from, to] = preview as [string, string];

  return (
    <div className="range-picker" ref={rootRef}>
      <button
        type="button"
        className="range-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          /*
           * 每次打開都跳到目前選的那一段，而不是停在上次翻到的地方或今天。
           * 出金表選的通常是上個月，開起來卻停在這個月的話，每次都要先按一次
           * 上一頁——而且會誤以為自己什麼都沒選。
           */
          const from = parse(start);
          if (!open) setAnchor(from ? monthStart(from.getUTCFullYear(), from.getUTCMonth()) : thisMonth());
          setPendingStart(null);
          setOpen((current) => !current);
        }}
      >
        <Icon name="calendar" />
        {label(start, end)}
      </button>

      {open ? (
        <div className="range-panel" role="dialog" aria-label="選擇對帳區間">
          <div className="range-presets">
            {presets().map((preset) => (
              <Button
                type="button"
                key={preset.label}
                variant="chip"
                selected={start === preset.start && end === preset.end}
                onClick={() => {
                  setPendingStart(null);
                  onChange({ start: preset.start, end: preset.end });
                  setOpen(false);
                }}
              >{preset.label}</Button>
            ))}
          </div>

          <div className="range-head">
            <button
              type="button"
              className="icon-button"
              onClick={() => setAnchor((current) => addMonths(current, -1))}
              title="上一個月"
              aria-label="上一個月"
            >
              <Icon name="chevronLeft" />
            </button>
            <span className="range-hint">
              {pendingStart ? "再點一次選迄日" : "點一下選起日"}
            </span>
            <button
              type="button"
              className="icon-button"
              onClick={() => setAnchor((current) => addMonths(current, 1))}
              title="下一個月"
              aria-label="下一個月"
            >
              <Icon name="chevronRight" />
            </button>
          </div>

          <div className="range-months" onMouseLeave={() => setHovered(null)}>
            {[anchor, addMonths(anchor, 1)].map((month) => (
              <div className="range-month" key={iso(month)}>
                <div className="range-month-title">
                  {month.getUTCFullYear()} 年 {month.getUTCMonth() + 1} 月
                </div>
                <div className="range-grid">
                  {WEEKDAYS.map((day) => (
                    <span className="range-weekday" key={day}>{day}</span>
                  ))}
                  {daysOf(month).map((day, index) => {
                    if (!day) return <span key={`pad-${index}`} />;
                    const value = iso(day);
                    const inRange = Boolean(from && to && value >= from && value <= to);
                    const edge = value === from || value === to;
                    return (
                      <button
                        type="button"
                        key={value}
                        className={`range-day${inRange ? " in" : ""}${edge ? " edge" : ""}`}
                        onMouseEnter={() => setHovered(value)}
                        onClick={() => pick(value)}
                      >
                        {day.getUTCDate()}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
