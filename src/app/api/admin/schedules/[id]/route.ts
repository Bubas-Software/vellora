import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import {
  deleteCaregiverScheduleEntry,
  getCaregiverScheduleEntry,
  updateCaregiverScheduleEntry,
} from "@/lib/data";
import { apiError } from "@/lib/api-error";
import { parseScheduleMutation, resolveScheduleMutation } from "@/lib/schedule-admin";
import {
  isPayrollPaidScheduleConflictError,
  isScheduleOverlapConflictError,
  PAYROLL_PAID_SCHEDULE_CONFLICT_MESSAGE,
  SCHEDULE_OVERLAP_CONFLICT_MESSAGE,
} from "@/lib/schedule-errors";

type RouteContext = { params: Promise<{ id: string }> };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "Escala inválida." }, { status: 400 });

  const parsed = parseScheduleMutation(await request.json().catch(() => null), guard.session.role === "admin");
  if (!parsed.data) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const existing = await getCaregiverScheduleEntry(id);
    if (!existing) return NextResponse.json({ error: "Escala não encontrada." }, { status: 404 });
    if (parsed.data.patient_id !== existing.patient_id) {
      return NextResponse.json({ error: "A escala não pode ser movida para outro paciente." }, { status: 400 });
    }
    const resolved = await resolveScheduleMutation(parsed.data, existing);
    if (!resolved.data) return NextResponse.json({ error: resolved.error }, { status: resolved.conflict ? 409 : 400 });
    await updateCaregiverScheduleEntry(id, resolved.data, guard.session.userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isPayrollPaidScheduleConflictError(error)) {
      return NextResponse.json({ error: PAYROLL_PAID_SCHEDULE_CONFLICT_MESSAGE }, { status: 409 });
    }
    if (isScheduleOverlapConflictError(error)) {
      return NextResponse.json({ error: SCHEDULE_OVERLAP_CONFLICT_MESSAGE }, { status: 409 });
    }
    return apiError(error, "api/admin/schedules", "Não foi possível atualizar a escala.");
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "Escala inválida." }, { status: 400 });
  try {
    const existing = await getCaregiverScheduleEntry(id);
    if (!existing) return NextResponse.json({ error: "Escala não encontrada." }, { status: 404 });
    await deleteCaregiverScheduleEntry(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, "api/admin/schedules", "Não foi possível remover a escala.");
  }
}
