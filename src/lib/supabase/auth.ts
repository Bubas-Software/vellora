import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionPayload } from "../auth";
import { runtimeValue } from "../runtime-config";
import {
  createSupabaseRequestClient,
  createSupabaseServerClient,
  createSupabaseStatelessClient,
  type SupabaseCookieState,
} from "./server";
import {
  mapSupabaseRole,
  mapSupabaseSession,
  type SupabaseAuthUser,
  type SupabaseProfile,
  type SupabaseRoleContext,
} from "./roles";
import type { NextRequest } from "next/server";

const SUPABASE_GLOBAL_SIGN_OUT_TIMEOUT_MS = 5_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export type SupabaseSignInResult = {
  session: SessionPayload | null;
  error: Error | null;
};

export async function getSupabaseRoleContextFromClient(
  client: SupabaseClient,
): Promise<SupabaseRoleContext | null> {
  const { data, error } = await client.rpc("get_my_profile_role_context");
  if (error) {
    console.error("[supabase-auth] Não foi possível consultar os perfis de acesso da sessão.", {
      error: error.message,
    });
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) return null;
  const rawRoles = Array.isArray(row.available_roles) ? row.available_roles : [];
  const availableRoles = rawRoles
    .map(mapSupabaseRole)
    .filter((role): role is NonNullable<typeof role> => role !== null);
  if (!availableRoles.length) return null;
  const activeRole = mapSupabaseRole(row.active_role);
  return {
    availableRoles,
    activeRole,
    needsSelection: row.needs_selection === true,
  };
}

export async function getSupabaseSessionFromClient(
  client: SupabaseClient,
): Promise<SessionPayload | null> {
  const {
    data: { user },
    error: userError,
  } = await client.auth.getUser();
  if (userError || !user) return null;

  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("name, role, active")
    .eq("id", user.id)
    .eq("active", true)
    .maybeSingle();

  if (profileError) {
    console.error("[supabase-auth] Não foi possível validar o perfil ativo.", {
      error: profileError.message,
    });
    return null;
  }

  const roleContext = await getSupabaseRoleContextFromClient(client);
  if (!roleContext) return null;
  return mapSupabaseSession(
    user as SupabaseAuthUser,
    profile as SupabaseProfile | null,
    roleContext,
  );
}

export async function getSupabaseSession(): Promise<SessionPayload | null> {
  try {
    const client = await createSupabaseServerClient();
    return getSupabaseSessionFromClient(client);
  } catch (error) {
    console.error("[supabase-auth] Não foi possível ler a sessão.", {
      error: error instanceof Error ? error.message : "Erro desconhecido",
    });
    return null;
  }
}

export async function signInWithSupabase(
  request: Pick<NextRequest, "cookies">,
  email: string,
  password: string,
  state: SupabaseCookieState,
): Promise<SupabaseSignInResult> {
  const client = createSupabaseRequestClient(request, state);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) return { session: null, error: error || new Error("Login sem usuário") };

  const session = await getSupabaseSessionFromClient(client);
  if (!session) {
    await client.auth.signOut({ scope: "local" });
    return { session: null, error: new Error("Conta sem perfil ativo") };
  }

  return { session, error: null };
}

export async function signOutWithSupabase(
  request: Pick<NextRequest, "cookies">,
  state: SupabaseCookieState,
): Promise<Error | null> {
  const client = createSupabaseRequestClient(request, state);
  const { error } = await client.auth.signOut({ scope: "local" });
  return error;
}

const SAFE_ORIGIN_PROTOCOLS = new Set(["http:", "https:"]);

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;

  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.slice(1).every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function parseSafeOrigin(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} deve ser uma URL válida.`);
  }

  if (
    !SAFE_ORIGIN_PROTOCOLS.has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new Error(`${label} deve apontar para uma origem HTTP(S) sem credenciais ou caminho.`);
  }

  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(`${label} deve usar HTTPS para hosts que não são de loopback.`);
  }

  return new URL(parsed.origin);
}

export function getSupabasePasswordResetRedirectUrl(requestUrl: string): string {
  let requestOrigin: URL;
  try {
    const request = new URL(requestUrl);
    if (!SAFE_ORIGIN_PROTOCOLS.has(request.protocol)) throw new Error("protocolo inválido");
    requestOrigin = new URL(request.origin);
  } catch {
    throw new Error("A origem da solicitação deve ser uma URL HTTP(S) válida.");
  }

  const configuredAppUrl = runtimeValue("VELLORA_APP_URL")?.trim();
  const baseUrl = isLoopbackHostname(requestOrigin.hostname)
    ? parseSafeOrigin(requestOrigin.origin, "A origem da solicitação")
    : configuredAppUrl
      ? parseSafeOrigin(configuredAppUrl, "VELLORA_APP_URL")
      : parseSafeOrigin(requestOrigin.origin, "A origem da solicitação");

  return new URL("/auth/callback", baseUrl.origin).toString();
}

export async function requestSupabasePasswordReset(
  email: string,
  redirectTo: string,
): Promise<Error | null> {
  // The email template carries the one-time token_hash. Use a stateless
  // client because @supabase/ssr forces PKCE on server clients, even when a
  // different flowType is supplied.
  const client = createSupabaseStatelessClient();
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
  return error;
}

export async function updateSupabasePassword(
  request: Pick<NextRequest, "cookies">,
  password: string,
  state: SupabaseCookieState,
): Promise<{ ok: boolean; error: Error | null }> {
  const client = createSupabaseRequestClient(request, state);
  const {
    data: { user },
    error: userError,
  } = await client.auth.getUser();
  if (userError || !user) return { ok: false, error: userError || new Error("Sessão ausente") };

  const { error } = await client.auth.updateUser({ password });
  if (error) return { ok: false, error };

  try {
    const signOutResult = await withTimeout(
      client.auth.signOut({ scope: "global" }),
      SUPABASE_GLOBAL_SIGN_OUT_TIMEOUT_MS,
    );
    if (signOutResult === null) {
      console.warn("[supabase-auth] Senha alterada, mas a revogação global excedeu o tempo limite.", {
        timeoutMs: SUPABASE_GLOBAL_SIGN_OUT_TIMEOUT_MS,
      });
    } else if (signOutResult.error) {
      console.error("[supabase-auth] Senha alterada, mas a revogação global falhou.", {
        error: signOutResult.error.message,
      });
    }
  } catch (error) {
    console.error("[supabase-auth] Senha alterada, mas a revogação global falhou.", {
      error: error instanceof Error ? error.message : "Erro desconhecido",
    });
  }

  return { ok: true, error: null };
}
