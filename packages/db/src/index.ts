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
export {
  CUSTOMER_PAGE_SIZES,
  CUSTOMER_SORT_FIELDS,
  defaultCustomerQuery,
  listCustomers,
  type CustomerListResult,
  type CustomerQuery,
  type CustomerSortField,
} from "./crm.js";
export { normalizePhone, validatePhone } from "./phone.js";
export {
  syncCyberbizCustomer,
  syncCyberbizCustomers,
  upsertCyberbizCustomers,
  type BulkSyncSummary,
  type BatchSyncSummary,
  type CyberbizSyncAction,
  type CyberbizSyncResult,
  type SyncContext,
} from "./crm-sync.js";
export {
  deleteEmptyCyberbizCustomers,
  processCustomerWebhook,
  readSyncStatus,
  retryFailedWebhooks,
  type ProcessWebhookInput,
  type SyncStatus,
  type WebhookOutcome,
} from "./crm-webhook.js";
export {
  EVENT_PAGE_SIZES,
  defaultEventQuery,
  listCustomerEvents,
  type EventQuery,
  type EventRow,
} from "./crm-events.js";
export {
  applyTagChange,
  createTag,
  deleteTagFromCatalog,
  listTags,
  renameTagInCatalog,
  type TagChangeResult,
  type TagRow,
} from "./crm-tags.js";
export {
  createCustomer,
  findCustomer,
  findCustomerByPhone,
  setCustomerBlocked,
  updateCustomer,
  type Actor,
  type CustomerInput,
} from "./crm-write.js";
