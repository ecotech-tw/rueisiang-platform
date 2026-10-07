-- 加班取消改為直接刪除申請（見 cancelHrOvertimeRequest）。先前留下的 cancelled 列不會再有人處理，
-- 一併清掉，申請紀錄才不會新舊兩種行為並存。沒有其他資料表以外鍵指向 hr_overtime_requests。
-- 刪除不可逆，所以先把整列抄進稽核事件；欄位名稱與程式取消時寫的快照一致。
INSERT INTO `activity_events` (`id`, `entity_type`, `entity_id`, `entity_label`, `event_type`, `summary`, `source`, `actor_type`, `payload_json`)
SELECT
  'evt-' || lower(hex(randomblob(16))),
  'hr_personnel',
  request.id,
  coalesce(nullif(trim(employment.legal_name), ''), nullif(employee.display_name, ''), nullif(employee.google_name, ''), employee.email),
  'overtime_request_purged',
  '清除先前已取消的加班申請',
  'hr',
  'system',
  json_object(
    'employeeUserId', employment.employee_user_id,
    'id', request.id,
    'employmentId', request.employment_id,
    'scopeId', request.scope_id,
    'requestedStart', request.requested_start,
    'requestedEnd', request.requested_end,
    'actualStart', request.actual_start,
    'actualEnd', request.actual_end,
    'settlementKind', request.settlement_kind,
    'status', request.status,
    'ratePpm', request.rate_ppm,
    'reason', request.reason,
    'reviewedBy', request.reviewed_by,
    'reviewedAt', request.reviewed_at,
    'decisionReason', request.decision_reason,
    'createdBy', request.created_by,
    'createdAt', request.created_at,
    'updatedAt', request.updated_at,
    'revision', request.revision
  )
FROM `hr_overtime_requests` AS request
INNER JOIN `hr_employments` AS employment ON employment.id = request.employment_id
INNER JOIN `users` AS employee ON employee.id = employment.employee_user_id
WHERE request.status = 'cancelled';--> statement-breakpoint
DELETE FROM `hr_overtime_requests` WHERE `status` = 'cancelled';
