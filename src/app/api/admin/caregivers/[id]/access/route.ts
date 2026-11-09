import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import {
  createCaregiverAccess,
  getCaregiverProfile,
  getUserByEmail,
} from "@/lib/data";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return NextResponse.json({ error: "Informe um e-mail de acesso válido." }, { status: 400 });
  }
  if (password.length < 12) {
    return NextResponse.json(
      { error: "A senha provisória deve ter pelo menos 12 caracteres." },
      { status: 400 }
    );
  }

  const profile = await getCaregiverProfile(id);
  if (!profile) {
    return NextResponse.json({ error: "Profissional não encontrado no banco de cuidadores." }, { status: 404 });
  }
  if (profile.user_id) {
    return NextResponse.json({ error: "Este profissional já possui acesso ao painel." }, { status: 409 });
  }
  if (profile.account_status !== "aguardando_acesso") {
    return NextResponse.json({ error: "Este perfil não está disponível para criação de acesso." }, { status: 409 });
  }
  if (await getUserByEmail(email)) {
    return NextResponse.json({ error: "Já existe uma conta com esse e-mail." }, { status: 409 });
  }

  try {
    const user = await createCaregiverAccess({ profileId: id, email, password });
    return NextResponse.json({ ok: true, id: user.id });
  } catch (error) {
    console.error("Falha ao criar acesso para profissional aprovado.", error);
    return NextResponse.json(
      { error: "Não foi possível criar o acesso. Verifique o e-mail e tente novamente." },
      { status: 400 }
    );
  }
}
