export { createDatabase, type Database } from "./client.js";
export * as schema from "./schema/index.js";
export { GLOBAL_SCOPE, type Role, type User, type UserRole } from "./schema/auth.js";
export { countOtherActiveAdmins, loadAuthUser, recordLogin, updateProfile } from "./users.js";
export { syncSystemRoles } from "./seed.js";
export {
  assignRole,
  findUser,
  hasRole,
  inviteUser,
  listRoles,
  listUsers,
  revokeRole,
  setUserStatus,
  type AdminUserRow,
  type AssignmentRow,
  type RoleGrant,
  type RoleRow,
} from "./admin.js";
