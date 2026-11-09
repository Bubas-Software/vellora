import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { apiError } from "@/lib/api-error";
import { DUPLICATE_ACCOUNT_EMAIL_MESSAGE, isDuplicateAccountEmailError } from "@/lib/user-errors";
import { createPatient, createUser, deleteFamilyUser, getUserByEmail, updateLeadStatus } from "@/lib/data";

function duplicateEmailResponse(): NextResponse {
  return NextResponse.json(
    { error: DUPLICATE_ACCOUNT_EMAIL_MESSAGE, code: "email_already_registered" },
    { status: 409 },
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => null);
  const name = (body?.name || "").trim();
  if (!name) return NextResponse.json({ error: "Nome do paciente é obrigatório." }, { status: 400 });

  let familyUserId: string | null = body?.family_user_id || null;
  let createdFamilyUserId: string | undefined;

  try {
    if (!familyUserId && body?.new_family_name && body?.new_family_email && body?.new_family_password) {
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

    const patient = await createPatient({
      name,
      birth_date: body?.birth_date || undefined,
      address: body?.address || undefined,
      care_level: body?.care_level || undefined,
      condition_summary: body?.condition_summary || undefined,
      family_user_id: familyUserId,
      status: body?.status || "pendente",
      notes: body?.notes || undefined,
    });
    // Once the patient exists, the account belongs to that patient and must
    // not be cleaned up if a later lead update fails.
    createdFamilyUserId = undefined;

    if (body?.lead_id) await updateLeadStatus(body.lead_id, "convertido");

    return NextResponse.json({ ok: true, id: patient.id });
  } catch (error) {
    if (createdFamilyUserId) {
      await deleteFamilyUser(createdFamilyUserId).catch((cleanupError) => {
        console.error("Não foi possível limpar a conta de família criada durante uma criação incompleta.", {
          error: cleanupError instanceof Error ? cleanupError.message : "Erro desconhecido",
        });
      });
    }
    if (isDuplicateAccountEmailError(error)) return duplicateEmailResponse();
    return apiError(error, "api/admin/patients", "Não foi possível criar o paciente.");
  }
}
