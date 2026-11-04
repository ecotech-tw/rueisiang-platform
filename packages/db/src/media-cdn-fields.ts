export const MEDIA_IMAGE_SORT_FIELDS = ["name", "contentType", "pixels", "size", "updatedAt", "createdAt", "status"] as const;
export type MediaImageSortField = typeof MEDIA_IMAGE_SORT_FIELDS[number];
export function isMediaImageSortField(value: string): value is MediaImageSortField {
  return MEDIA_IMAGE_SORT_FIELDS.some((field) => field === value);
}

export const MEDIA_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MEDIA_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const MEDIA_IMAGE_MAX_PIXELS = 16_000_000;
export const MEDIA_IMAGE_MAX_SIDE = 8192;
export const MEDIA_IMAGE_RULE = "JPEG、PNG、WebP 靜態圖片；每張最多 10 MB、1600 萬像素，單邊最多 8192 px。";
