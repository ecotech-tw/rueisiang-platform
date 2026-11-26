-- 把時間欄位裡 JS toISOString() 寫進來的 ISO（2026-10-01T10:00:00.000Z）轉成資料庫格式
-- （2026-10-01 10:00:00.000）。只動開頭是「日期T」的值；轉換失敗（strftime 回 NULL）的留原樣。
-- %f 保留毫秒：小香 DO 存的舊 generation 要跟轉換後的值是同一個時間點，少了毫秒會被當成較舊而略過訊息。
--
-- 有 UPDATE trigger 的表一律不動（D1 關不掉 trigger，已結帳薪資等守門 trigger 會讓整支 migration 失敗）。
-- 這些表的時間由 HR 程式寫成資料庫格式，正式庫備份裡也沒有 ISO；就算有漏網的，讀取端兩種格式都吃。
-- 略過的表：hr_annual_leave_entitlements、hr_bonus_policy_members、hr_clock_events、hr_compensation_versions、hr_employee_scopes、hr_employment_attendance_settings、hr_employment_service_periods、hr_employments、hr_form_requests、hr_insurance_versions、hr_leave_requests、hr_monthly_hourly_entries、hr_monthly_leave_entries、hr_overtime_requests、hr_payroll_adjustment_items、hr_payroll_adjustments、hr_payroll_closed_employees、hr_payroll_closed_workers、hr_payroll_periods、hr_payroll_record_items、hr_payroll_record_withdrawals、hr_payroll_runs、hr_payroll_withdrawals、hr_payroll_worker_results、hr_payslips、hr_schedule_entries、hr_schedule_worker_entries、hr_schedule_workers、hr_shift_templates、hr_shift_versions、hr_special_workday_assignments、hr_special_workday_rule_versions、hr_worker_account_links、hr_worker_compensation_versions、hr_worker_overtime_requests
UPDATE `activity_events` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_channel_tools` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_chat_tools` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_configs` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_hr_request_drafts` SET `expires_at` = strftime('%Y-%m-%d %H:%M:%f', `expires_at`) WHERE `expires_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `expires_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_hr_request_drafts` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_hr_request_drafts` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_line_channels` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_line_channels` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_line_groups` SET `discovered_at` = strftime('%Y-%m-%d %H:%M:%f', `discovered_at`) WHERE `discovered_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `discovered_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_line_groups` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_line_groups` SET `profile_synced_at` = strftime('%Y-%m-%d %H:%M:%f', `profile_synced_at`) WHERE `profile_synced_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `profile_synced_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_line_groups` SET `context_reset_at` = strftime('%Y-%m-%d %H:%M:%f', `context_reset_at`) WHERE `context_reset_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `context_reset_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_line_messages` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_line_push_deliveries` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_line_push_deliveries` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_line_queue_jobs` SET `locked_until` = strftime('%Y-%m-%d %H:%M:%f', `locked_until`) WHERE `locked_until` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `locked_until`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_line_queue_jobs` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_line_queue_jobs` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_line_reply_backups` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_prompt_revisions` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_runs` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_sandbox_messages` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_sandbox_sessions` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_sandbox_sessions` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_sandbox_sessions` SET `closed_at` = strftime('%Y-%m-%d %H:%M:%f', `closed_at`) WHERE `closed_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `closed_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_tool_calls` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `assistant_tool_configs` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `auth_device_sessions` SET `rotated_at` = strftime('%Y-%m-%d %H:%M:%f', `rotated_at`) WHERE `rotated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `rotated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `auth_device_sessions` SET `expires_at` = strftime('%Y-%m-%d %H:%M:%f', `expires_at`) WHERE `expires_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `expires_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `auth_device_sessions` SET `revoked_at` = strftime('%Y-%m-%d %H:%M:%f', `revoked_at`) WHERE `revoked_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `revoked_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `auth_device_sessions` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `auth_line_account_links` SET `linked_at` = strftime('%Y-%m-%d %H:%M:%f', `linked_at`) WHERE `linked_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `linked_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `crm_customers` SET `cyberbiz_updated_at` = strftime('%Y-%m-%d %H:%M:%f', `cyberbiz_updated_at`) WHERE `cyberbiz_updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `cyberbiz_updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `crm_customers` SET `synced_at` = strftime('%Y-%m-%d %H:%M:%f', `synced_at`) WHERE `synced_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `synced_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `crm_customers` SET `blocked_at` = strftime('%Y-%m-%d %H:%M:%f', `blocked_at`) WHERE `blocked_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `blocked_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `crm_customers` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `crm_customers` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `crm_saved_views` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `crm_saved_views` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `crm_tags` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `crm_tags` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `cyberbiz_products` SET `cyberbiz_updated_at` = strftime('%Y-%m-%d %H:%M:%f', `cyberbiz_updated_at`) WHERE `cyberbiz_updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `cyberbiz_updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `cyberbiz_products` SET `synced_at` = strftime('%Y-%m-%d %H:%M:%f', `synced_at`) WHERE `synced_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `synced_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `cyberbiz_sync_locks` SET `lease_until` = strftime('%Y-%m-%d %H:%M:%f', `lease_until`) WHERE `lease_until` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `lease_until`) IS NOT NULL;
--> statement-breakpoint
UPDATE `cyberbiz_webhook_events` SET `received_at` = strftime('%Y-%m-%d %H:%M:%f', `received_at`) WHERE `received_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `received_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `cyberbiz_webhook_events` SET `processed_at` = strftime('%Y-%m-%d %H:%M:%f', `processed_at`) WHERE `processed_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `processed_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `cyberbiz_webhook_events` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_annual_leave_ledger` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_annual_leave_policy_versions` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_attendance_location_schedules` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_attendance_location_schedules` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_attendance_locations` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_attendance_locations` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_bonus_policies` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_bonus_policies` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_bonus_policy_version_scopes` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_bonus_policy_versions` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_bonus_policy_versions` SET `voided_at` = strftime('%Y-%m-%d %H:%M:%f', `voided_at`) WHERE `voided_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `voided_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_calendar_day_scopes` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_calendar_days` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_calendar_days` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_compensation_items` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_employee_attendance_locations` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_employee_attendance_locations` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_employee_personal_data` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_employee_personal_data` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_employee_photos` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_employee_photos` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_employee_rfid_cards` SET `linked_at` = strftime('%Y-%m-%d %H:%M:%f', `linked_at`) WHERE `linked_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `linked_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_employee_rfid_cards` SET `revoked_at` = strftime('%Y-%m-%d %H:%M:%f', `revoked_at`) WHERE `revoked_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `revoked_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_employment_actions` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_employment_actions` SET `undone_at` = strftime('%Y-%m-%d %H:%M:%f', `undone_at`) WHERE `undone_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `undone_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_insurance_contribution_rules` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_insurance_rate_tables` SET `fetched_at` = strftime('%Y-%m-%d %H:%M:%f', `fetched_at`) WHERE `fetched_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `fetched_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_insurance_rate_tables` SET `activated_at` = strftime('%Y-%m-%d %H:%M:%f', `activated_at`) WHERE `activated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `activated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_leave_grant_batches` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_leave_grant_ledger` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_leave_grants` SET `revoked_at` = strftime('%Y-%m-%d %H:%M:%f', `revoked_at`) WHERE `revoked_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `revoked_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_leave_grants` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_leave_types` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_leave_types` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_notifications` SET `read_at` = strftime('%Y-%m-%d %H:%M:%f', `read_at`) WHERE `read_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `read_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_notifications` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_payroll_jobs` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_payroll_jobs` SET `started_at` = strftime('%Y-%m-%d %H:%M:%f', `started_at`) WHERE `started_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `started_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_payroll_jobs` SET `completed_at` = strftime('%Y-%m-%d %H:%M:%f', `completed_at`) WHERE `completed_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `completed_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_payroll_jobs` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_rfid_enrollment_sessions` SET `started_at` = strftime('%Y-%m-%d %H:%M:%f', `started_at`) WHERE `started_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `started_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_rfid_enrollment_sessions` SET `expires_at` = strftime('%Y-%m-%d %H:%M:%f', `expires_at`) WHERE `expires_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `expires_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_rfid_enrollment_sessions` SET `scanned_at` = strftime('%Y-%m-%d %H:%M:%f', `scanned_at`) WHERE `scanned_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `scanned_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_rfid_enrollment_sessions` SET `finished_at` = strftime('%Y-%m-%d %H:%M:%f', `finished_at`) WHERE `finished_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `finished_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_schedule_managers` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_schedule_managers` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_schedule_scope_locks` SET `locked_at` = strftime('%Y-%m-%d %H:%M:%f', `locked_at`) WHERE `locked_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `locked_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_schedule_scope_locks` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_schedule_scope_locks` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_schedule_versions` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_schedule_versions` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_schedule_versions` SET `locked_at` = strftime('%Y-%m-%d %H:%M:%f', `locked_at`) WHERE `locked_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `locked_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_scope_shift_assignments` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_special_workday_allowances` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_special_workday_overtime_rules` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_special_workday_rules` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `hr_special_workday_rules` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `item_categories` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `item_categories` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `item_components` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `item_components` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `items` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `items` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `media_cdn_blobs` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `media_cdn_images` SET `deleted_at` = strftime('%Y-%m-%d %H:%M:%f', `deleted_at`) WHERE `deleted_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `deleted_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `media_cdn_images` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `media_cdn_images` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `media_objects` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `media_objects` SET `expires_at` = strftime('%Y-%m-%d %H:%M:%f', `expires_at`) WHERE `expires_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `expires_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `momo_report_payout_snapshots` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `momo_report_payout_snapshots` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `momo_report_sales_snapshots` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `momo_report_sales_snapshots` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `permissions` SET `synced_at` = strftime('%Y-%m-%d %H:%M:%f', `synced_at`) WHERE `synced_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `synced_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `report_bundle_sales_monthly` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `report_bundle_sales_monthly` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `report_external_products` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `report_external_products` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `report_ingest_issues` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `report_item_sales_monthly` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `report_item_sales_monthly` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `report_item_sales_period` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `report_item_sales_period` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `report_payout_daily` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `report_payout_daily` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `report_runs` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `report_runs` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `role_permission_grants` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `roles` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `roles` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `scopes` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `scopes` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `scopes` SET `archived_at` = strftime('%Y-%m-%d %H:%M:%f', `archived_at`) WHERE `archived_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `archived_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `store_locator_profiles` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `store_locator_profiles` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `store_locator_publication` SET `published_at` = strftime('%Y-%m-%d %H:%M:%f', `published_at`) WHERE `published_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `published_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `user_permission_grants` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `user_role_assignments` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `users` SET `invitation_expires_at` = strftime('%Y-%m-%d %H:%M:%f', `invitation_expires_at`) WHERE `invitation_expires_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `invitation_expires_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `users` SET `password_set_at` = strftime('%Y-%m-%d %H:%M:%f', `password_set_at`) WHERE `password_set_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `password_set_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `users` SET `last_login_at` = strftime('%Y-%m-%d %H:%M:%f', `last_login_at`) WHERE `last_login_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `last_login_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `users` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `users` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `wms_categories` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `wms_categories` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `wms_items` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `wms_items` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `wms_layout_elements` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `wms_layout_elements` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `wms_layouts` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `wms_layouts` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `wms_shelves` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `wms_shelves` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `wms_zone_images` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `wms_zones` SET `created_at` = strftime('%Y-%m-%d %H:%M:%f', `created_at`) WHERE `created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `created_at`) IS NOT NULL;
--> statement-breakpoint
UPDATE `wms_zones` SET `updated_at` = strftime('%Y-%m-%d %H:%M:%f', `updated_at`) WHERE `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND strftime('%Y-%m-%d %H:%M:%f', `updated_at`) IS NOT NULL;
