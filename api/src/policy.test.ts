import { describe, expect, it } from "vitest";
import { canAssignRole, canManageMember, hasPermission } from "./policy.js";
import { rankBetween } from "./rank.js";

describe("workspace role policy", () => {
  it("keeps viewers read-only and restricts member management", () => {
    expect(hasPermission("VIEWER", "read")).toBe(true);
    expect(hasPermission("VIEWER", "write")).toBe(false);
    expect(hasPermission("MEMBER", "manageMembers")).toBe(false);
    expect(hasPermission("ADMIN", "manageMembers")).toBe(true);
  });

  it("limits admin member management and role assignment", () => {
    expect(canManageMember("ADMIN", "OWNER")).toBe(false);
    expect(canManageMember("ADMIN", "ADMIN")).toBe(false);
    expect(canManageMember("ADMIN", "MEMBER")).toBe(true);
    expect(canAssignRole("ADMIN", "ADMIN")).toBe(false);
    expect(canAssignRole("ADMIN", "VIEWER")).toBe(true);
    expect(canAssignRole("OWNER", "ADMIN")).toBe(true);
    expect(canAssignRole("OWNER", "OWNER")).toBe(false);
  });
});

describe("fractional task ranks", () => {
  it("creates a sortable key between neighboring keys", () => {
    const first = rankBetween(null, null);
    const second = rankBetween(first, null);
    const middle = rankBetween(first, second);

    expect(first < middle).toBe(true);
    expect(middle < second).toBe(true);
  });
});
