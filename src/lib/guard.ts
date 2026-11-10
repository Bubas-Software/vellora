import { NextResponse } from "next/server";
import { getSession, Role, SessionPayload } from "./auth";
import { isSafePreview } from "./preview";

export async function requireRole(...roles: Role[]): Promise<{ session: SessionPayload } | { error: NextResponse }> {
  if (isSafePreview()) {
    return {
      error: NextResponse.json(
        { error: "Área restrita indisponível nesta prévia sanitizada." },
        { status: 403 }
      ),
    };
  }
  const session = await getSession();
  if (!session) {
    return { error: NextResponse.json({ error: "Não autenticado." }, { status: 401 }) };
  }
  if (session.roleSelectionRequired) {
    return {
      error: NextResponse.json(
        { error: "Escolha um perfil de acesso antes de continuar.", redirect: "/selecionar-perfil" },
        { status: 409 },
      ),
    };
  }
  if (!roles.includes(session.role)) {
    return { error: NextResponse.json({ error: "Sem permissão." }, { status: 403 }) };
  }
  return { session };
}
