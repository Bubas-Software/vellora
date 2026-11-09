import type { Role } from "./auth";

export function canAccessAdminArea(role: Role): boolean {
  return role === "admin" || role === "coordenador_operacional";
}

export function isAdminOnlyPath(pathname: string): boolean {
  return ["/admin/finance", "/admin/precificacao", "/admin/projecoes", "/admin/acessos"]
    .some((path) => pathname === path || pathname.startsWith(`${path}/`));
}
