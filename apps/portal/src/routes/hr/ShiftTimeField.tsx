import { useRef, useState } from "react";
import { Button, Field } from "../../ui/index.js";

const VALID_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function ShiftTimeField({ label, ariaLabel, value, disabled, onChange }: { label: string; ariaLabel: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const [nativeFallback, setNativeFallback] = useState(false);
  const openPicker = () => {
    const picker = pickerRef.current;
    if (!picker || disabled) return;
    try {
      if (!picker.showPicker) { setNativeFallback(true); return; }
      picker.showPicker();
    } catch {
      // 舊瀏覽器或嵌入頁可能禁止 showPicker；保留可直接操作的原生欄位，不把點選入口變成死按鈕。
      setNativeFallback(true);
    }
  };
  return <Field label={label} required>
    <div className="shift-time-control">
      <input type="text" aria-label={ariaLabel} placeholder="HH:mm" maxLength={5} autoComplete="off" required value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      <Button variant="icon" icon="clock" className="absolute inset-y-0 right-0.5 my-auto" aria-label={`點選${ariaLabel}`} disabled={disabled} onClick={openPicker} />
    </div>
    <input ref={pickerRef} type="time" aria-label={`${ariaLabel}時間選擇器`} aria-hidden={!nativeFallback} tabIndex={nativeFallback ? 0 : -1} className={nativeFallback ? "shift-time-fallback" : "sr-only"} value={VALID_TIME.test(value) ? value : ""} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
  </Field>;
}
