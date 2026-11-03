/**
 * 呼叫端在 className 給了同一個屬性的 utility，就拿掉元件自己的預設值。
 *
 * 兩個沒有 variant 的 utility 改同一個屬性時，誰贏要看 Tailwind 的產生順序，不是看
 * 誰寫在後面，所以只能整組取代、不能疊上去。帶 variant 的（`max-[760px]:min-w-0`）
 * 不算：Tailwind 一律把有 variant 的排在後面，疊上去本來就是它贏。
 */
export function defaultUnless(className: string, prefix: string, fallback: string) {
  return new RegExp(`(^|\\s)${prefix}`).test(className) ? "" : fallback;
}
