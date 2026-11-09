import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { createUser, listUsersByRole } from "@/lib/data";
import { apiError } from "@/lib/api-error";
import { isValidEmail } from "@/lib/validation";

export async function GET() {
  const guard = await requireRole("admin");
  if ("error" in guard) return guard.error;

  try {
    const users = await listUsersByRole("coordenador_operacional", true);
    return NextResponse.json({
      accounts: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        active: user.deleted_at === null,
      })),
    });
  } catch (error) {
    return apiError(error, "api/admin/coordinators", "Não foi possível listar as contas da coordenação.");
  }
}

export async function POST(request: NextRequest) {
  const guard = await requireRole("admin");
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (name.length < 2 || name.length > 100) {
    return NextResponse.json({ error: "Informe um nome entre 2 e 100 caracteres." }, { status: 400 });
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "Informe um e-mail válido." }, { status: 400 });
  }
  if (password.length < 12 || password.length > 128) {
    return NextResponse.json({ error: "A senha inicial deve ter entre 12 e 128 caracteres." }, { status: 400 });
  }

  try {
    const user = await createUser({ name, email, password, role: "coordenador_operacional" });
    return NextResponse.json({ ok: true, account: { id: user.id, name: user.name, email: user.email } }, { status: 201 });
  } catch (error) {
    return apiError(error, "api/admin/coordinators", "Não foi possível criar a conta da coordenação.");
  }
}
