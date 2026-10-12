// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ShiftTimeField } from "./ShiftTimeField.js";

async function renderField(disabled = false) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  function Form() {
    const [value, setValue] = useState("09:00");
    return <ShiftTimeField label="開始時間" ariaLabel="開始時間" value={value} disabled={disabled} onChange={setValue} />;
  }
  await act(async () => root.render(<Form />));
  const text = container.querySelector<HTMLInputElement>('input[type="text"]')!;
  const native = container.querySelector<HTMLInputElement>('input[type="time"]')!;
  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  return { text, native, trigger, change: async (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }), cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

it("文字輸入與原生點選共用同一時間，無效草稿不餵入原生選擇器", async () => {
  const field = await renderField();
  try {
    const showPicker = vi.fn(); Object.assign(field.native, { showPicker });
    await field.change(field.text, "10:30");
    expect(field.native.value).toBe("10:30");
    await act(async () => field.trigger.click()); expect(showPicker).toHaveBeenCalledOnce();
    await field.change(field.native, "11:45"); expect(field.text.value).toBe("11:45");
    await field.change(field.text, "25:00"); expect(field.text.value).toBe("25:00"); expect(field.native.value).toBe("");
  } finally { await field.cleanup(); }
});

it.each(["不存在", "拒絕"])("showPicker %s 時保留可操作的原生欄位", async (mode) => {
  const field = await renderField();
  try {
    Object.assign(field.native, { showPicker: mode === "拒絕" ? () => { throw new DOMException("禁止開啟", "NotAllowedError"); } : undefined });
    await act(async () => field.trigger.click());
    expect(field.native.getAttribute("aria-hidden")).toBe("false");
    expect(field.native.tabIndex).toBe(0); expect(field.native.className).toBe("shift-time-fallback");
    await field.change(field.native, "12:15"); expect(field.text.value).toBe("12:15");
  } finally { await field.cleanup(); }
});

it("唯讀或儲存中停用文字輸入與點選入口", async () => {
  const field = await renderField(true);
  try {
    const showPicker = vi.fn(); Object.assign(field.native, { showPicker });
    expect(field.text.disabled).toBe(true); expect(field.native.disabled).toBe(true); expect(field.trigger.disabled).toBe(true);
    await act(async () => field.trigger.click()); expect(showPicker).not.toHaveBeenCalled();
  } finally { await field.cleanup(); }
});
