import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { createCaregiverScheduleEntry, getPatient } from "@/lib/data";
import { apiError } from "@/lib/api-error";
import { parseScheduleMutation, resolveScheduleMutation } from "@/lib/schedule-admin";
import { isScheduleOverlapConflictError, SCHEDULE_OVERLAP_CONFLICT_MESSAGE } from "@/lib/schedule-errors";

export async function POST(request: NextRequest) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const parsed = parseScheduleMutation(await request.json().catch(() => null), guard.session.role === "admin");
  if (!parsed.data) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    if (!(await getPatient(parsed.data.patient_id))) {
      return NextResponse.json({ error: "Paciente não encontrado." }, { status: 404 });
    }
    const resolved = await resolveScheduleMutation(parsed.data);
    if (!resolved.data) return NextResponse.json({ error: resolved.error }, { status: resolved.conflict ? 409 : 400 });

    const entry = await createCaregiverScheduleEntry(resolved.data, guard.session.userId);
    return NextResponse.json({ ok: true, id: entry.id });
  } catch (error) {
    if (isScheduleOverlapConflictError(error)) {
      return NextResponse.json({ error: SCHEDULE_OVERLAP_CONFLICT_MESSAGE }, { status: 409 });
    }
    return apiError(error, "api/admin/schedules", "Não foi possível adicionar o profissional à escala.");
  }
}
