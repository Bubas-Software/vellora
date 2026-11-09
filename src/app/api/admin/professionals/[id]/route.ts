import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import {
  deleteProfessionalApplication,
  updateProfessionalApplicationStatus,
  type ProfessionalApplication,
} from "@/lib/data";
import { apiError } from "@/lib/api-error";

const VALID_STATUS: ProfessionalApplication["status"][] = ["novo", "em_analise", "aprovado", "recusado"];

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const status = body?.status as ProfessionalApplication["status"];
  if (!VALID_STATUS.includes(status)) {
    return NextResponse.json({ error: "Status inválido." }, { status: 400 });
  }

  try {
    await updateProfessionalApplicationStatus(id, status, guard.session.userId);
    return NextResponse.json({
      ok: true,
      addedToCaregiverBank: status === "aprovado",
    });
  } catch (error) {
    return apiError(error, "api/admin/professionals", "Não foi possível atualizar a candidatura.");
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const { id } = await params;
  try {
    await deleteProfessionalApplication(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, "api/admin/professionals", "Não foi possível excluir o formulário.");
  }
}
