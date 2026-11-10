import { useState, type ReactNode } from "react";
import { reportPlatformLabel } from "@rueisiang/db/report-platforms";
import { useSession } from "../../../auth/session.js";
import { usePageTitle } from "../../../shell/usePageTitle.js";
import { Alert, Page, PageHeader, SelectField } from "../../../ui/index.js";
import { ShopeeSales } from "../ShopeeSales.js";
import { MoPlusUpload } from "./MoPlusUpload.js";
import { REPORT_SOURCE_ADAPTERS } from "./report-adapters.js";

export function UploadReports() {
  usePageTitle("上傳報表");
  const { permissions } = useSession();
  const sourcePermissions = {
    shopee: ["tools:shopee-sales:run"],
    momo: ["tools:momo-report:run"],
  } as const;
  const available = REPORT_SOURCE_ADAPTERS
    .filter((adapter) => adapter.inputMode === "upload")
    .filter((adapter) => {
      const permission = sourcePermissions[adapter.sourceType as keyof typeof sourcePermissions];
      return permission ? permission.every((required) => permissions.has(required)) : false;
    })
    .map((adapter) => ({ value: adapter.sourceType, label: reportPlatformLabel(adapter.sourceType) }));
  const [selected, setSelected] = useState(available[0]?.value ?? "");
  const sourceType = available.some((source) => source.value === selected) ? selected : available[0]?.value ?? "";

  const sourceField: ReactNode = available.length > 1 ? (
    <SelectField
      className="min-w-[180px] flex-[1_1_190px]"
      label="報表來源"
      value={sourceType}
      onChange={(event) => setSelected(event.target.value)}
      options={available}
    />
  ) : null;

  return (
    <Page>
      <PageHeader title="上傳報表" />
      {!available.length ? <Alert tone="warning">你沒有任何上傳報表的執行權限。</Alert> : null}
      {sourceType === "momo" ? <MoPlusUpload sourceField={sourceField} /> : null}
      {sourceType === "shopee" ? <ShopeeSales embedded sourceField={sourceField} /> : null}
    </Page>
  );
}
