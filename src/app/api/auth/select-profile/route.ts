import { NextRequest, NextResponse } from "next/server";
import { createSessionToken, getAuthProvider, getSession, roleHomePath, SESSION_COOKIE_NAME, type Role } from "@/lib/auth";
import { isSafePreview } from "@/lib/preview";
import { isSameOriginRequest } from "@/lib/abuse-prevention";
import { isAdminOnlyPath } from "@/lib/permissions";
import { applySupabaseCookieState, createSupabaseCookieState, createSupabaseRequestClient } from "@/lib/supabase/server";
import { getSupabaseSessionFromClient } from "@/lib/supabase/auth";

const roles = new Set<Role>(["admin", "coordenador_operacional", "familia", "cuidador"]);

function redirectForRole(role: Role, requested: unknown): string {
  const fallback = roleHomePath(role);
  if (typeof requested !== "string" || !requested.startsWith("/") || requested.startsWith("//")) return fallback;
  if ((role === "admin" || role === "coordenador_operacional") && requested.startsWith("/admin")) {
    if (role === "coordenador_operacional" && isAdminOnlyPath(requested)) return fallback;
    return requested;
  }
  if (role === "familia" && requested.startsWith("/familia")) return requested;
  if (role === "cuidador" && requested.startsWith("/cuidador")) return requested;
  return fallback;
}

export async function POST(request: NextRequest) {
  if (isSafePreview()) {
    return NextResponse.json({ error: "Área restrita indisponível nesta prévia sanitizada." }, { status: 403 });
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const role = typeof body?.role === "string" ? body.role as Role : null;
  if (!role || !roles.has(role)) {
    return NextResponse.json({ error: "Selecione um perfil de acesso válido." }, { status: 400 });
  }

  try {
    if (getAuthProvider() === "supabase") {
      const state = createSupabaseCookieState();
      const client = createSupabaseRequestClient(request, state);
      const { data: auth, error: authError } = await client.auth.getUser();
      if (authError || !auth.user) {
        return applySupabaseCookieState(NextResponse.json({ error: "Sessão não autenticada." }, { status: 401 }), state);
      }
      const { error } = await client.rpc("select_active_profile_role", { p_role: role });
      if (error) {
        return applySupabaseCookieState(NextResponse.json({ error: "Este perfil não está disponível para a conta." }, { status: 403 }), state);
      }
      const session = await getSupabaseSessionFromClient(client);
      if (!session || session.role !== role || session.roleSelectionRequired) {
        return applySupabaseCookieState(NextResponse.json({ error: "Não foi possível confirmar o perfil selecionado." }, { status: 403 }), state);
      }
      return applySupabaseCookieState(NextResponse.json({
        ok: true,
        role,
        redirect: redirectForRole(role, body?.next),
      }), state);
    }

    const session = await getSession();
    if (!session || !session.availableRoles?.includes(role)) {
      return NextResponse.json({ error: "Este perfil não está disponível para a conta." }, { status: 403 });
    }
    const token = await createSessionToken({
      userId: session.userId,
      name: session.name,
      role,
      sessionVersion: session.sessionVersion,
      profileSelected: true,
    });
    const response = NextResponse.json({ ok: true, role, redirect: redirectForRole(role, body?.next) });
    response.cookies.set(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      priority: "high",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return response;
  } catch (error) {
    console.error("[api/auth/select-profile] Não foi possível selecionar o perfil.", {
      error: error instanceof Error ? error.message : "Erro desconhecido",
    });
    return NextResponse.json({ error: "Não foi possível selecionar o perfil. Tente entrar novamente." }, { status: 503 });
  }
}
