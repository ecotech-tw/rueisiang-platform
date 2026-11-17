/*
 * 換條件時畫面上還是舊資料（placeholder 或重新抓取中）：變淡並擋掉點擊，免得對著舊資料操作。
 *
 * 只在載入中才掛上，所以轉場只管「變淡」那一段；載入完拿掉時直接回到不透明。
 */
export const REFRESHING = "pointer-events-none opacity-55 [transition:opacity_150ms_ease-out]";
