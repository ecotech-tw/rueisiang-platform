import Skeleton from "react-loading-skeleton";
import type { ReactNode } from "react";

export type HrSkeletonVariant = "dashboard" | "table" | "calendar" | "detail";

const SKELETON_BASE_COLOR = "rgba(213, 56, 59, 0.15)";
const SKELETON_HIGHLIGHT_COLOR = "rgba(255, 255, 255, 0.92)";

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <Skeleton
    inline
    className="hr-skeleton-block"
    containerClassName={`hr-skeleton-block-container ${className}`.trim()}
    baseColor={SKELETON_BASE_COLOR}
    highlightColor={SKELETON_HIGHLIGHT_COLOR}
    duration={1.4}
  />;
}

export function HrSkeletonTableRow({ columns = 5 }: { columns?: number }) {
  return <tr className="hr-skeleton-table-row" aria-hidden="true">
    {Array.from({ length: columns }, (_, index) => <td key={index}><SkeletonBlock className={index === 0 ? "is-long" : index === columns - 1 ? "is-short" : ""} /></td>)}
  </tr>;
}

function SkeletonTable({ columns = 5, rows = 7 }: { columns?: number; rows?: number }) {
  return <div className="hr-skeleton-table" aria-hidden="true">
    <div className="hr-skeleton-table-line is-header">{Array.from({ length: columns }, (_, index) => <SkeletonBlock key={index} className={index === 0 ? "is-long" : ""} />)}</div>
    {Array.from({ length: rows }, (_, row) => <div className="hr-skeleton-table-line" key={row}>{Array.from({ length: columns }, (_, index) => <SkeletonBlock key={index} className={index === 0 ? "is-long" : index === columns - 1 ? "is-short" : ""} />)}</div>)}
  </div>;
}

function SkeletonPanel({ children }: { children: ReactNode }) {
  return <section className="hr-skeleton-panel">{children}</section>;
}

function SkeletonPageHead() {
  return <div className="hr-skeleton-page-head" aria-hidden="true">
    <div><SkeletonBlock className="is-title" /><SkeletonBlock className="is-description" /></div>
    <SkeletonBlock className="is-action" />
  </div>;
}

function TablePageSkeleton() {
  return <SkeletonPanel>
    <div className="hr-skeleton-panel-head" aria-hidden="true"><SkeletonBlock className="is-panel-title" /><SkeletonBlock className="is-panel-description" /></div>
    <div className="hr-skeleton-toolbar" aria-hidden="true"><SkeletonBlock /><SkeletonBlock /><SkeletonBlock className="is-short" /></div>
    <SkeletonTable />
  </SkeletonPanel>;
}

function DashboardSkeleton() {
  return <div className="hr-skeleton-dashboard" aria-hidden="true">
    <div className="hr-skeleton-dashboard-grid">{Array.from({ length: 4 }, (_, index) => <SkeletonPanel key={index}>
      <SkeletonBlock className="is-icon" />
      <SkeletonBlock className="is-value" />
      <SkeletonBlock className="is-card-description" />
      <SkeletonBlock className="is-card-action" />
    </SkeletonPanel>)}</div>
  </div>;
}

function CalendarSkeleton() {
  return <SkeletonPanel>
    <div className="hr-skeleton-toolbar is-calendar" aria-hidden="true"><SkeletonBlock className="is-nav" /><SkeletonBlock className="is-month" /><SkeletonBlock className="is-nav" /><SkeletonBlock /><SkeletonBlock /></div>
    <div className="hr-skeleton-calendar" aria-hidden="true">{Array.from({ length: 35 }, (_, index) => <SkeletonPanel key={index}><SkeletonBlock className="is-calendar-date" /><SkeletonBlock className="is-calendar-entry" /><SkeletonBlock className="is-calendar-entry is-short" /></SkeletonPanel>)}</div>
  </SkeletonPanel>;
}

function DetailSkeleton() {
  return <SkeletonPanel>
    <SkeletonBlock className="is-detail-title" />
    {Array.from({ length: 6 }, (_, index) => <div className="hr-skeleton-detail-row" key={index}><SkeletonBlock className="is-detail-label" /><SkeletonBlock className={index % 2 ? "is-long" : ""} /></div>)}
  </SkeletonPanel>;
}

export function HrPageSkeleton({ variant = "table" }: { variant?: HrSkeletonVariant }) {
  return <div className={`page hr-skeleton-page hr-skeleton-page-${variant}`} role="status" aria-label="載入中">
    <SkeletonPageHead />
    {variant === "dashboard" ? <DashboardSkeleton /> : variant === "calendar" ? <CalendarSkeleton /> : variant === "detail" ? <DetailSkeleton /> : <TablePageSkeleton />}
  </div>;
}
