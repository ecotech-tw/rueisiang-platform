/**
 * tools/ 刻意不在 pnpm workspace 裡（它相依 Playwright，拉進 workspace 會讓每個人的
 * pnpm install 都扛一份只有 CI 用得到的瀏覽器函式庫），所以那邊是純 JS、沒有型別。
 *
 * 只有 src/dev 的種子腳本會跨這條界線，這裡補上它用到的形狀。Worker 打包不會碰到
 * src/dev，正式程式碼也不該 import tools/ 的東西。
 */
declare module "*/tools/cyberbiz-reports/shop/parser.mjs" {
  export interface ShopStatementItem {
    sku: string;
    productName: string;
    category: string;
    quantity: number;
    grossAmount: number;
    discountAmount: number;
    salesAmount: number;
  }

  export interface ShopStatement {
    period: { start: string; end: string; reportMonth: string };
    summary: Record<string, number>;
    revenueAmount: number;
    settlementAmount: number;
    items: ShopStatementItem[];
    charges: Array<{ sku: string; salesAmount: number }>;
  }

  export function parseShopReport(filePath: string): Promise<ShopStatement>;
}
