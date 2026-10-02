export type WorkspaceRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

export type Permission = "read" | "write" | "manageMembers" | "manageWorkspace";

const rolePermissions: Record<WorkspaceRole, ReadonlySet<Permission>> = {
  OWNER: new Set(["read", "write", "manageMembers", "manageWorkspace"]),
  ADMIN: new Set(["read", "write", "manageMembers"]),
  MEMBER: new Set(["read", "write"]),
  VIEWER: new Set(["read"]),
};

export function hasPermission(role: WorkspaceRole, permission: Permission): boolean {
  return rolePermissions[role].has(permission);
}

export function canManageMember(actor: WorkspaceRole, target: WorkspaceRole): boolean {
  if (target === "OWNER") return false;
  if (actor === "OWNER") return true;
  return actor === "ADMIN" && (target === "MEMBER" || target === "VIEWER");
}

export function canAssignRole(actor: WorkspaceRole, role: WorkspaceRole): boolean {
  if (role === "OWNER") return false;
  if (actor === "OWNER") return true;
  return actor === "ADMIN" && (role === "MEMBER" || role === "VIEWER");
}
