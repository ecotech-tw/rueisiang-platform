export interface ShopeePreviewRow {
  reportMonth: string;
  sku: string;
  productName: string;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
}

export interface ShopeePreview {
  reportMonths: string[];
  sourceRowCount: number;
  rowCount: number;
  rows: ShopeePreviewRow[];
  uniqueOrders: number;
  uniqueProducts: number;
  totalPerformance: number;
  totalQuantity: number;
  totalSalesAmount: number;
  duplicateRowsExcluded: number;
  warnings: string[];
}

export function shopeePreviewKey(requestId: string, token: string): string {
  return `shopee-sales-preview/${requestId}/${token}.json`;
}
