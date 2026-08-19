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
