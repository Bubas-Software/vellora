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

export function mapSupabaseRole(value: unknown): Role | null {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (role === "admin" || role === "coordenador_operacional" || role === "familia" || role === "cuidador") return role;
  return null;
}

export function mapSupabaseSession(
  user: SupabaseAuthUser | null | undefined,
  profile: SupabaseProfile | null | undefined,
): SessionPayload | null {
  if (!user?.id || profile?.active !== true) return null;

  const role = mapSupabaseRole(profile.role);
  if (!role) return null;

  const profileName = typeof profile.name === "string" ? profile.name.trim() : "";
  const email = typeof user.email === "string" ? user.email.trim() : "";

  return {
    userId: user.id,
    name: profileName || email || "Usuário Vellora",
    role,
    // Supabase Auth owns session invalidation; this field only keeps the
    // legacy SessionPayload contract stable during the gradual migration.
    sessionVersion: 0,
  };
}
