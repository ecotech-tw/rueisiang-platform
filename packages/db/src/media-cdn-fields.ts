export const MEDIA_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MEDIA_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const MEDIA_IMAGE_MAX_PIXELS = 16_000_000;
export const MEDIA_IMAGE_MAX_SIDE = 8192;
export const MEDIA_IMAGE_RULE = "JPEG、PNG、WebP 靜態圖片；每張最多 10 MB、1600 萬像素，單邊最多 8192 px。";
