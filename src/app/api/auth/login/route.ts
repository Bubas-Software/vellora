import { NextRequest, NextResponse } from "next/server";
import { verifyPassword, createSessionToken, SESSION_COOKIE_NAME, roleHomePath } from "@/lib/auth";
import { getAuthProvider } from "@/lib/auth";
import { isSafePreview } from "@/lib/preview";
import { consumeRateLimit, isSameOriginRequest } from "@/lib/abuse-prevention";
import { isValidEmail } from "@/lib/validation";
import {
  applySupabaseCookieState,
  createSupabaseCookieState,
} from "@/lib/supabase/server";
import { signInWithSupabase } from "@/lib/supabase/auth";

export async function POST(req: NextRequest) {
  if (isSafePreview()) {
    return NextResponse.json(
      { error: "Área restrita indisponível nesta prévia sanitizada." },
      { status: 403 }
    );
  }

  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.toLowerCase().trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!email || !password || !isValidEmail(email)) {
    return NextResponse.json({ error: "Informe e-mail e senha." }, { status: 400 });
  }

  const rate = await consumeRateLimit(req, "auth-login", { limit: 10, windowSeconds: 900 }, email);
  if (rate.reason === "provider_unavailable") {
    return NextResponse.json(
      { error: "O serviço está temporariamente indisponível. Tente novamente em alguns instantes." },
      { status: 503 }
    );
  }
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
    );
  }

  try {
    if (getAuthProvider() === "supabase") {
      const state = createSupabaseCookieState();
      const result = await signInWithSupabase(req, email, password, state);
      if (!result.session) {
        const response = NextResponse.json({ error: "E-mail ou senha inválidos." }, { status: 401 });
        return applySupabaseCookieState(response, state);
      }

      const response = NextResponse.json({
        ok: true,
        role: result.session.role,
        availableRoles: result.session.availableRoles,
        needsRoleSelection: result.session.roleSelectionRequired === true,
        redirect: result.session.roleSelectionRequired
          ? "/selecionar-perfil"
          : roleHomePath(result.session.role),
      });
      return applySupabaseCookieState(response, state);
    }

    const { getUserByEmail, listUserRoles } = await import("@/lib/data");
    const user = await getUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return NextResponse.json({ error: "E-mail ou senha inválidos." }, { status: 401 });
    }

    const availableRoles = await listUserRoles(user.id);
    if (!availableRoles.length) {
      return NextResponse.json({ error: "Esta conta não tem um perfil de acesso ativo." }, { status: 403 });
    }
    const selectedRole = availableRoles.includes(user.role) ? user.role : availableRoles[0];
    const needsRoleSelection = availableRoles.length > 1;

    const token = await createSessionToken({
      userId: user.id,
      name: user.name,
      role: selectedRole,
      sessionVersion: user.session_version,
      profileSelected: !needsRoleSelection,
    });
    const res = NextResponse.json({
      ok: true,
      role: selectedRole,
      availableRoles,
      needsRoleSelection,
      redirect: needsRoleSelection ? "/selecionar-perfil" : roleHomePath(selectedRole),
    });
    res.cookies.set(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: req.nextUrl.protocol === "https:",
      sameSite: "lax",
      priority: "high",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return res;
  } catch (error) {
    console.error("[api/auth/login] Não foi possível consultar a conta.", {
      error: error instanceof Error ? error.message : "Erro desconhecido",
    });
    return NextResponse.json(
      { error: "A área restrita está temporariamente indisponível. Tente novamente em instantes." },
      { status: 503 }
    );
  }
}
