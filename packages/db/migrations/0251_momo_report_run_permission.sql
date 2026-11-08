INSERT OR IGNORE INTO permissions (permission)
VALUES ('tools:momo-report:run');
--> statement-breakpoint
INSERT OR IGNORE INTO role_permission_grants (role_id, permission)
SELECT id, 'tools:momo-report:run' FROM roles WHERE role_key IN ('admin', 'manager');
