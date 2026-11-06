INSERT OR IGNORE INTO permissions (permission)
VALUES ('tools:mo-plus-sales:run');
--> statement-breakpoint
INSERT OR IGNORE INTO role_permission_grants (role_id, permission)
SELECT id, 'tools:mo-plus-sales:run' FROM roles WHERE role_key IN ('admin', 'manager');
