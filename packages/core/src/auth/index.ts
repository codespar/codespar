export type { Role, Permission } from "./rbac.js";
export {
  ROLE_PERMISSIONS,
  hasPermission,
  canExecuteIntent,
  getRequiredRole,
} from "./rbac.js";

export type { UserIdentity } from "./identity.js";
export { IdentityResolver } from "./identity.js";

export { IdentityStore } from "./identity-store.js";
