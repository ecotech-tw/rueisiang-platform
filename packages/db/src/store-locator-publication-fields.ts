export interface StoreLocatorPublicationStatus {
  revision: number;
  publishedRevision: number;
  publishedAt: string | null;
  error: string | null;
  pending: boolean;
}

/** 已存檔但無法回讀發布狀態時，不用假的版本號冒充已知狀態。 */
export type StoreLocatorPublicationResult = StoreLocatorPublicationStatus | {
  revision: null;
  publishedRevision: null;
  publishedAt: null;
  error: string;
  pending: true;
};
