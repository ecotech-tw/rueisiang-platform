-- 角色管理改成只有管理員是系統角色，其餘既有角色都交給管理者 CRUD。
-- 只改分類，不動角色權限與指派，讓既有使用者的授權不會因升級消失。
UPDATE roles
SET is_system = 0
WHERE key <> 'admin' AND is_system = 1;
