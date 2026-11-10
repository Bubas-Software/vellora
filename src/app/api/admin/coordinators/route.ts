import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import {
  createUser,
  findUserByEmailIncludingInactive,
  getUserById,
  grantCoordinatorRole,
  listUserRoles,
  listUsersByRole,
} from "@/lib/data";
import { apiError } from "@/lib/api-error";
import { isValidEmail } from "@/lib/validation";
import { isDuplicateAccountEmailError } from "@/lib/user-errors";

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
        profileActive: user.deleted_at === null,
        active: user.deleted_at === null && user.membership_active !== false,
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
  const action = typeof body?.action === "string" ? body.action : "create";
  if (action === "check_email") {
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!isValidEmail(email)) {
      return NextResponse.json({ error: "Informe um e-mail válido." }, { status: 400 });
    }
    try {
      const user = await findUserByEmailIncludingInactive(email);
      if (!user) return NextResponse.json({ exists: false });
      const roles = await listUserRoles(user.id);
      return NextResponse.json({
        exists: true,
        account: {
          id: user.id,
          name: user.name,
          email: user.email,
          active: user.deleted_at === null,
          roles,
        },
      });
    } catch (error) {
      return apiError(error, "api/admin/coordinators", "Não foi possível consultar essa conta.");
    }
  }

  if (action === "grant_existing") {
    const userId = typeof body?.userId === "string" ? body.userId : "";
    if (!userId || body?.confirmed !== true) {
      return NextResponse.json({ error: "Confirme a adição do perfil de coordenação." }, { status: 400 });
    }
    try {
      const user = await getUserById(userId);
      if (!user) return NextResponse.json({ error: "Conta não encontrada." }, { status: 404 });
      await grantCoordinatorRole(user.id, guard.session.userId);
      return NextResponse.json({
        ok: true,
        account: { id: user.id, name: user.name, email: user.email },
      });
    } catch (error) {
      return apiError(error, "api/admin/coordinators", "Não foi possível adicionar o acesso à conta.");
    }
  }

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
    const existing = await findUserByEmailIncludingInactive(email);
    if (existing) {
      const roles = await listUserRoles(existing.id);
      return NextResponse.json({
        code: "account_exists",
        account: {
          id: existing.id,
          name: existing.name,
          email: existing.email,
          active: existing.deleted_at === null,
          roles,
        },
      }, { status: 409 });
    }
    const user = await createUser({ name, email, password, role: "coordenador_operacional" });
    return NextResponse.json({ ok: true, account: { id: user.id, name: user.name, email: user.email } }, { status: 201 });
  } catch (error) {
    if (isDuplicateAccountEmailError(error)) {
      const existing = await findUserByEmailIncludingInactive(email).catch(() => undefined);
      if (existing) {
        const roles = await listUserRoles(existing.id).catch(() => []);
        return NextResponse.json({
          code: "account_exists",
          account: {
            id: existing.id,
            name: existing.name,
            email: existing.email,
            active: existing.deleted_at === null,
            roles,
          },
        }, { status: 409 });
      }
      return NextResponse.json({
        code: "auth_account_without_profile",
        error: "Este e-mail já existe na autenticação, mas não há um perfil Vellora vinculado. A conta foi preservada e precisa de revisão antes de receber outro acesso.",
      }, { status: 409 });
    }
    return apiError(error, "api/admin/coordinators", "Não foi possível criar a conta da coordenação.");
  }
}
