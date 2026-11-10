import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { runtimeValue } from "./runtime-config";
import { resolveAuthProvider, type AuthProvider } from "./auth-provider";
import { getSupabaseSession } from "./supabase/auth";

export type Role = "admin" | "coordenador_operacional" | "familia" | "cuidador";

export type SessionPayload = {
  userId: string;
  name: string;
  role: Role;
  sessionVersion: number;
  availableRoles?: Role[];
  roleSelectionRequired?: boolean;
  profileSelected?: boolean;
};

const SESSION_COOKIE = "vellora_session";

function sessionSecret(): Uint8Array {
  const secretValue = runtimeValue("VELLORA_SESSION_SECRET");
  if (!secretValue) {
    throw new Error("Configure VELLORA_SESSION_SECRET antes de habilitar o acesso restrito.");
  }
  return new TextEncoder().encode(secretValue);
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(sessionSecret());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    if (
      typeof payload.userId === "string" &&
      typeof payload.name === "string" &&
      typeof payload.sessionVersion === "number" &&
      (payload.role === "admin" || payload.role === "coordenador_operacional" || payload.role === "familia" || payload.role === "cuidador")
    ) {
      return {
        userId: payload.userId,
        name: payload.name,
        role: payload.role,
        sessionVersion: payload.sessionVersion,
        profileSelected: payload.profileSelected === true,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<SessionPayload | null> {
  return getAuthProvider() === "supabase" ? getSupabaseSession() : getLegacySession();
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

export function getAuthProvider(): AuthProvider {
  return resolveAuthProvider(runtimeValue("VELLORA_AUTH_PROVIDER"));
}

async function getLegacySession(): Promise<SessionPayload | null> {
  const { query, queryOne } = await import("./db");
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = await verifySessionToken(token);
  if (!payload) return null;

  const user = await queryOne<{ session_version: number }>(
    "SELECT session_version FROM users WHERE id = $1 AND deleted_at IS NULL",
    [payload.userId]
  );
  if (!user || user.session_version !== payload.sessionVersion) {
    return null;
  }
  const rows = await query<{ role: Role }>(
    "SELECT role FROM user_role_memberships WHERE user_id = $1 AND active = 1 ORDER BY is_default DESC, role",
    [payload.userId],
  );
  const availableRoles = rows.map((row) => row.role);
  if (!availableRoles.includes(payload.role)) return null;
  return {
    ...payload,
    availableRoles,
    roleSelectionRequired: availableRoles.length > 1 && payload.profileSelected !== true,
  };
}

export function roleHomePath(role: Role): string {
  if (role === "admin" || role === "coordenador_operacional") return "/admin";
  if (role === "familia") return "/familia";
  return "/cuidador";
}
