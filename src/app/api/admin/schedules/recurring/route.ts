import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { createCaregiverScheduleEntries, getPatient } from "@/lib/data";
import { requireRole } from "@/lib/guard";
import {
  parseRecurringScheduleMutation,
  resolveRecurringScheduleMutation,
} from "@/lib/schedule-admin";
import { isScheduleOverlapConflictError, SCHEDULE_OVERLAP_CONFLICT_MESSAGE } from "@/lib/schedule-errors";

export async function POST(request: NextRequest) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const parsed = parseRecurringScheduleMutation(await request.json().catch(() => null));
  if (!parsed.data) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    if (!(await getPatient(parsed.data.patient_id))) {
      return NextResponse.json({ error: "Paciente não encontrado." }, { status: 404 });
    }
    const resolved = await resolveRecurringScheduleMutation(parsed.data);
    if (!resolved.data) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.conflict ? 409 : 400 });
    }

    const createdCount = await createCaregiverScheduleEntries(resolved.data, guard.session.userId);
    return NextResponse.json({ ok: true, created_count: createdCount });
  } catch (error) {
    if (isScheduleOverlapConflictError(error)) {
      return NextResponse.json({ error: SCHEDULE_OVERLAP_CONFLICT_MESSAGE }, { status: 409 });
    }
    return apiError(error, "api/admin/schedules/recurring", "Não foi possível aplicar a recorrência à escala.");
  }
}
