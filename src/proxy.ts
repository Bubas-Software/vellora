import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { isSafePreview } from "@/lib/preview";
import { runtimeValue } from "@/lib/runtime-config";
import { getAuthProvider, type Role, roleHomePath } from "@/lib/auth";
import { isAdminOnlyPath } from "@/lib/permissions";
import { proxySupabaseAuth } from "@/lib/supabase/proxy";
import { enforceAdminMutationSecurity } from "@/lib/request-security";

const SESSION_COOKIE = "vellora_session";

const ROLE_PREFIX: Record<string, readonly Role[]> = {
  "/admin": ["admin", "coordenador_operacional"],
  "/familia": ["familia"],
  "/cuidador": ["cuidador"],
};

export async function proxy(req: NextRequest) {
  const mutationSecurityResponse = enforceAdminMutationSecurity(req);
  if (mutationSecurityResponse) return mutationSecurityResponse;

  const { pathname } = req.nextUrl;
  const matchedPrefix = Object.keys(ROLE_PREFIX).find((p) => pathname.startsWith(p));
  if (!matchedPrefix) return NextResponse.next();

  if (isSafePreview()) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("preview", "segura");
    return NextResponse.redirect(url);
  }

  const allowedRoles = ROLE_PREFIX[matchedPrefix];
  if (getAuthProvider() === "supabase") {
    return proxySupabaseAuth(req, allowedRoles);
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  try {
    const secretValue = runtimeValue("VELLORA_SESSION_SECRET");
    if (!secretValue) throw new Error("VELLORA_SESSION_SECRET não configurada.");
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secretValue));
    if (
      typeof payload.userId !== "string" ||
      typeof payload.sessionVersion !== "number" ||
      typeof payload.role !== "string"
    ) {
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
    const { query, queryOne } = await import("@/lib/db");
    const user = await queryOne<{ role: string; session_version: number }>(
      "SELECT role, session_version FROM users WHERE id = $1 AND deleted_at IS NULL",
      [payload.userId]
    );
    const memberships = await query<{ role: string }>(
      "SELECT role FROM user_role_memberships WHERE user_id = $1 AND active = 1",
      [payload.userId],
    );
    const role = payload.role as Role | undefined;
    const hasActiveRole = typeof role === "string" && memberships.some((membership) => membership.role === role);
    if (!user || !hasActiveRole || user.session_version !== payload.sessionVersion) {
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
    if (memberships.length > 1 && payload.profileSelected !== true) {
      const url = req.nextUrl.clone();
      url.pathname = "/selecionar-perfil";
      url.search = "";
      url.searchParams.set("next", pathname + req.nextUrl.search);
      return NextResponse.redirect(url);
    }
    const isAllowedRole = role === "admin"
      ? allowedRoles.includes("admin")
      : role === "coordenador_operacional"
        ? allowedRoles.includes("coordenador_operacional") && !isAdminOnlyPath(pathname)
        : typeof role === "string" && allowedRoles.includes(role as Role);
    if (!isAllowedRole) {
      const url = req.nextUrl.clone();
      url.pathname = roleHomePath(role!);
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  } catch (error) {
    console.error("[proxy] A sessão recebida não pôde ser validada.", {
      error: error instanceof Error ? error.message : "Erro desconhecido",
      pathname,
    });
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
}

export const config = {
  matcher: ["/admin/:path*", "/familia/:path*", "/cuidador/:path*", "/api/admin/:path*"],
};
