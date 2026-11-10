import type { SupabaseClient } from "@supabase/supabase-js";
import { mapSupabaseSession, type SupabaseProfile } from "./roles";
import { getSupabaseRoleContextFromClient } from "./auth";

/**
 * Proxy-only session lookup. getClaims() verifies the token and supplies only
 * the immutable subject used to read the caller's own profile through RLS.
 * Role and display data always come from public.profiles, never from claims.
 */
export async function getSupabaseProxySession(
  client: SupabaseClient,
) {
  const { data, error } = await client.auth.getClaims();
  if (error) return null;

  const subject = typeof data?.claims?.sub === "string" ? data.claims.sub : "";
  if (!subject) return null;

  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("name, role, active")
    .eq("id", subject)
    .eq("active", true)
    .maybeSingle();

  if (profileError) return null;
  const roleContext = await getSupabaseRoleContextFromClient(client);
  if (!roleContext) return null;
  return mapSupabaseSession({ id: subject }, profile as SupabaseProfile | null, roleContext);
}
