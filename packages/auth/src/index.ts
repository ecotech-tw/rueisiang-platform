export {
  ALL_PERMISSIONS,
  PERMISSIONS,
  SYSTEM_ROLES,
  type Permission,
  type SystemRoleKey,
} from "./permissions.js";

export {
  GLOBAL_SCOPE,
  can,
  permissionsOf,
  type AuthUser,
  type RoleAssignment,
  type UserStatus,
} from "./rbac.js";

export {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  newSessionClaims,
  signSession,
  verifySession,
  type SessionClaims,
} from "./session.js";

export {
  DEVICE_SESSION_COOKIE,
  DEVICE_SESSION_IDLE_SECONDS,
  DEVICE_SESSION_REUSE_GRACE_SECONDS,
  DEVICE_SESSION_ROTATE_SECONDS,
  hashDeviceSecret,
  newDeviceToken,
  parseDeviceToken,
  serializeDeviceToken,
  type DeviceToken,
} from "./device-session.js";

export { clearCookie, readCookie, serializeCookie, type CookieOptions } from "./cookies.js";

export { signPayload, verifyPayload, type Expiring } from "./signed.js";

export {
  buildAuthorizeUrl,
  createPkce,
  exchangeCode,
  fetchGoogleAvatar,
  randomToken,
  verifyIdToken,
  type GoogleIdentity,
  type PkcePair,
} from "./google-oauth.js";

export {
  INVITE_TTL_DAYS,
  hashInviteToken,
  hashPassword,
  inviteExpiryFrom,
  newInviteToken,
  validatePassword,
  verifyPassword,
} from "./password.js";
