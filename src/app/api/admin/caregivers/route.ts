import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { createManualCaregiver, getUserByEmail } from "@/lib/data";
import { apiError } from "@/lib/api-error";
import { isValidEmail } from "@/lib/validation";
import { DUPLICATE_ACCOUNT_EMAIL_MESSAGE, isDuplicateAccountEmailError } from "@/lib/user-errors";

const VALID_PROFESSIONS = new Set(["cuidador", "tecnico_enfermagem", "enfermeiro", "outros"]);

export async function POST(req: NextRequest) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  const profession = typeof body?.profession === "string" ? body.profession : "";

  if (!name || !email || !password || !profession) {
    return NextResponse.json({ error: "Nome, área profissional, e-mail e senha são obrigatórios." }, { status: 400 });
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "Informe um e-mail de acesso válido." }, { status: 400 });
  }
  if (password.length < 12) {
    return NextResponse.json({ error: "A senha provisória deve ter pelo menos 12 caracteres." }, { status: 400 });
  }
  if (!VALID_PROFESSIONS.has(profession)) {
    return NextResponse.json({ error: "Informe uma área profissional válida." }, { status: 400 });
  }
  try {
    if (await getUserByEmail(email.toLowerCase())) {
      return NextResponse.json({ error: DUPLICATE_ACCOUNT_EMAIL_MESSAGE }, { status: 409 });
    }

    const user = await createManualCaregiver({
      name,
      email,
      password,
      phone,
      profession: profession as "cuidador" | "tecnico_enfermagem" | "enfermeiro" | "outros",
    });
    return NextResponse.json({ ok: true, id: user.id });
  } catch (error) {
    if (isDuplicateAccountEmailError(error)) {
      return NextResponse.json({ error: DUPLICATE_ACCOUNT_EMAIL_MESSAGE, code: "email_already_registered" }, { status: 409 });
    }
    return apiError(error, "api/admin/caregivers", "Não foi possível cadastrar o profissional agora. Tente novamente.");
  }
}
