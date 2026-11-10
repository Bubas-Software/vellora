import type { Role, SessionPayload } from "../auth";

export type SupabaseProfile = {
  name?: unknown;
  role?: unknown;
  active?: unknown;
};

export type SupabaseAuthUser = {
  id: string;
  email?: string | null;
};

export type SupabaseRoleContext = {
  availableRoles: Role[];
  activeRole: Role | null;
  needsSelection: boolean;
};

export function mapSupabaseRole(value: unknown): Role | null {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (role === "admin" || role === "coordenador_operacional" || role === "familia" || role === "cuidador") return role;
  return null;
}

export function mapSupabaseSession(
  user: SupabaseAuthUser | null | undefined,
  profile: SupabaseProfile | null | undefined,
  context?: SupabaseRoleContext | null,
): SessionPayload | null {
  if (!user?.id || profile?.active !== true) return null;

  const profileRole = mapSupabaseRole(profile.role);
  const availableRoles = context?.availableRoles || (profileRole ? [profileRole] : []);
  const role = context?.activeRole || availableRoles[0] || profileRole;
  if (!role || availableRoles.length === 0) return null;

  const profileName = typeof profile.name === "string" ? profile.name.trim() : "";
  const email = typeof user.email === "string" ? user.email.trim() : "";

  return {
    userId: user.id,
    name: profileName || email || "Usuário Vellora",
    role,
    availableRoles,
    roleSelectionRequired: context?.needsSelection === true,
    profileSelected: context?.needsSelection !== true,
    // Supabase Auth owns session invalidation; this field only keeps the
    // legacy SessionPayload contract stable during the gradual migration.
    sessionVersion: 0,
  };
}
