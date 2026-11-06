export const REPORT_PLATFORM_OPTIONS = [
  { value: "cyberbiz", label: "CYBERBIZ", acquisition: "adapter" },
  { value: "shopee", label: "蝦皮", acquisition: "upload" },
  { value: "mo_plus", label: "Mo+", acquisition: "upload" },
] as const;

export type ReportPlatform = typeof REPORT_PLATFORM_OPTIONS[number]["value"];

export function isReportPlatform(value: string): value is ReportPlatform {
  return REPORT_PLATFORM_OPTIONS.some((option) => option.value === value);
}

export function reportPlatformLabel(value: string): string {
  return REPORT_PLATFORM_OPTIONS.find((option) => option.value === value)?.label ?? value;
}
