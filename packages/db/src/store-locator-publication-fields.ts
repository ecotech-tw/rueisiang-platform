export interface StoreLocatorPublicationStatus {
  revision: number;
  publishedRevision: number;
  publishedAt: string | null;
  error: string | null;
  pending: boolean;
}
