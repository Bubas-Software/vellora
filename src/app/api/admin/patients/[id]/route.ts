import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { apiError } from "@/lib/api-error";
import { DUPLICATE_ACCOUNT_EMAIL_MESSAGE, isDuplicateAccountEmailError } from "@/lib/user-errors";
import { updatePatient, createUser, deleteFamilyUser, deletePatient, getUserByEmail } from "@/lib/data";
import { ScheduleHistoryConflictError } from "@/lib/schedule-errors";

function duplicateEmailResponse(): NextResponse {
  return NextResponse.json(
    { error: DUPLICATE_ACCOUNT_EMAIL_MESSAGE, code: "email_already_registered" },
    { status: 409 },
  );
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Corpo inválido." }, { status: 400 });

  let familyUserId: string | undefined = body.family_user_id;
  let createdFamilyUserId: string | undefined;

  try {
    if (!familyUserId && body.new_family_name && body.new_family_email && body.new_family_password) {
      if (body.new_family_password.length < 12) {
        return NextResponse.json({ error: "A senha provisória deve ter pelo menos 12 caracteres." }, { status: 400 });
      }
      const existing = await getUserByEmail(body.new_family_email.toLowerCase().trim());
      if (existing) return duplicateEmailResponse();

      const familyUser = await createUser({
        name: body.new_family_name.trim(),
        email: body.new_family_email.trim(),
        password: body.new_family_password,
        role: "familia",
        phone: body.new_family_phone?.trim(),
      });
      familyUserId = familyUser.id;
      createdFamilyUserId = familyUser.id;
    }

    await updatePatient(id, {
      name: body.name,
      birth_date: body.birth_date,
      address: body.address,
      care_level: body.care_level,
      condition_summary: body.condition_summary,
      status: body.status,
      notes: body.notes,
      ...(familyUserId ? { family_user_id: familyUserId } : {}),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (createdFamilyUserId) {
      await deleteFamilyUser(createdFamilyUserId).catch((cleanupError) => {
        console.error("Não foi possível limpar a conta de família criada durante uma atualização incompleta.", {
          error: cleanupError instanceof Error ? cleanupError.message : "Erro desconhecido",
        });
      });
    }
    if (isDuplicateAccountEmailError(error)) return duplicateEmailResponse();
    return apiError(error, "api/admin/patients/[id]", "Não foi possível salvar o paciente.");
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole("admin");
  if ("error" in guard) return guard.error;

  const { id } = await params;
  try {
    await deletePatient(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ScheduleHistoryConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return apiError(error, "api/admin/patients/[id]", "Não foi possível excluir o paciente.");
  }
}
