import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { deleteCaregiverProfile, getCaregiverProfile, updateCaregiverProfile } from "@/lib/data";
import { apiError } from "@/lib/api-error";
import { isValidCaregiverId, parseCaregiverProfileUpdate } from "@/lib/caregiver-update";
import { ScheduleHistoryConflictError } from "@/lib/schedule-errors";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const { id } = await params;
  if (!isValidCaregiverId(id)) {
    return NextResponse.json({ error: "Identificador do profissional inválido." }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = parseCaregiverProfileUpdate(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const profile = await getCaregiverProfile(id);
    if (!profile) {
      return NextResponse.json({ error: "Cadastro profissional não encontrado." }, { status: 404 });
    }
    await updateCaregiverProfile(id, parsed.value);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, "api/admin/caregivers/[id]", "Não foi possível salvar os dados do profissional.");
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole("admin");
  if ("error" in guard) return guard.error;

  const { id } = await params;
  try {
    await deleteCaregiverProfile(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ScheduleHistoryConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return apiError(error, "api/admin/caregivers", "Não foi possível excluir o cadastro profissional.");
  }
}
