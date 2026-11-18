import { sql, type SQLWrapper } from "drizzle-orm";

export type HrClockEventKind = "clock_in" | "clock_out" | null;

export function classifyDailyClockEvents<T extends { eventKind: HrClockEventKind; occurredAt: string }>(events: readonly T[]) {
  return events.map((event, index) => ({
    ...event,
    eventKind: index === 0 ? "clock_in" as const : index === events.length - 1 ? "clock_out" as const : null,
  }));
}

/** Keep paginated event lists correct without loading every event for an employee into memory. */
export function dailyClockEventKindSql(id: SQLWrapper, employeeUserId: SQLWrapper, occurredAt: SQLWrapper) {
  return sql<HrClockEventKind>`CASE
    WHEN ${id} = (
      SELECT earliest.id FROM hr_clock_events AS earliest
      WHERE earliest.employee_user_id = ${employeeUserId}
        AND date(earliest.occurred_at, '+8 hours') = date(${occurredAt}, '+8 hours')
      ORDER BY earliest.occurred_at, earliest.rowid LIMIT 1
    ) THEN 'clock_in'
    WHEN ${id} = (
      SELECT latest.id FROM hr_clock_events AS latest
      WHERE latest.employee_user_id = ${employeeUserId}
        AND date(latest.occurred_at, '+8 hours') = date(${occurredAt}, '+8 hours')
      ORDER BY latest.occurred_at DESC, latest.rowid DESC LIMIT 1
    ) THEN 'clock_out'
    ELSE NULL
  END`;
}
