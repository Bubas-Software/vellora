import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { deleteRecord, getRecord, updateRecord } from "@/lib/data";
import { apiError } from "@/lib/api-error";
import {
  parseForm,
  parseRecordFields,
  photoFieldsForPatch,
  readPhoto,
} from "@/app/api/records/route";

type RouteParams = { params: Promise<{ id: string; recordId: string }> };

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const { id: patientId, recordId } = await params;
  const existing = await getRecord(recordId);
  if (!existing || existing.patient_id !== patientId) {
    return NextResponse.json({ error: "Registro não encontrado para este paciente." }, { status: 404 });
  }

  const form = await parseForm(req);
  if (form instanceof NextResponse) return form;
  const postedPatientId = form.get("patient_id");
  if (postedPatientId !== patientId) {
    return NextResponse.json({ error: "Paciente do registro não confere." }, { status: 400 });
  }

  const parsed = parseRecordFields(form);
  if (!parsed.values) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const photo = await readPhoto(form);
  if (photo.error) return NextResponse.json({ error: photo.error }, { status: 400 });

  try {
    const updated = await updateRecord(
      recordId,
      {
        ...parsed.values,
        ...photoFieldsForPatch(form, photo),
      },
      { userId: guard.session.userId, name: guard.session.name },
    );
    if (!updated) return NextResponse.json({ error: "Registro não encontrado." }, { status: 404 });
    return NextResponse.json({ ok: true, id: updated.id, updated: true });
  } catch (error) {
    return apiError(error, "api/admin/patients/records", "Não foi possível atualizar o registro agora.");
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const guard = await requireRole("admin");
  if ("error" in guard) return guard.error;

  const { id: patientId, recordId } = await params;
  try {
    const existing = await getRecord(recordId);
    if (!existing || existing.patient_id !== patientId) {
      return NextResponse.json({ error: "Registro não encontrado para este paciente." }, { status: 404 });
    }
    const deleted = await deleteRecord(recordId);
    if (!deleted) return NextResponse.json({ error: "Registro não encontrado." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, "api/admin/patients/records", "Não foi possível excluir o registro agora.");
  }
}
