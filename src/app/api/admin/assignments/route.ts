import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { createAssignment } from "@/lib/data";
import { apiError } from "@/lib/api-error";
import { AssignmentConflictError } from "@/lib/assignment-errors";

export async function POST(req: NextRequest) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => null);
  const patientId = body?.patient_id;
  const caregiverUserId = body?.caregiver_user_id;
  const startDate = body?.start_date || new Date().toISOString().slice(0, 10);

  if (!patientId || !caregiverUserId) {
    return NextResponse.json({ error: "Selecione paciente e cuidador." }, { status: 400 });
  }

  try {
    const assignment = await createAssignment({ patient_id: patientId, caregiver_user_id: caregiverUserId, start_date: startDate });
    return NextResponse.json({ ok: true, id: assignment.id });
  } catch (error) {
    if (error instanceof AssignmentConflictError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    return apiError(error, "api/admin/assignments", "Não foi possível vincular o cuidador.");
  }
}
