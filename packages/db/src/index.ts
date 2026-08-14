export { createDatabase, type Database } from "./client.js";
export * as schema from "./schema/index.js";
export { GLOBAL_SCOPE, type Role, type User, type UserRole } from "./schema/auth.js";
export { countOtherActiveAdmins, loadAuthUser, recordLogin } from "./users.js";
export { ensureBootstrapAdmin, syncSystemRoles } from "./seed.js";
