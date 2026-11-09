import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { deleteLead, updateLeadStatus } from "@/lib/data";
import { apiError } from "@/lib/api-error";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const status = body?.status;
  const valid = ["novo", "em_contato", "convertido", "recusado"];
  if (!valid.includes(status)) {
    return NextResponse.json({ error: "Status inválido." }, { status: 400 });
  }
  try {
    await updateLeadStatus(id, status);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, "api/admin/leads", "Não foi possível atualizar a solicitação.");
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const { id } = await params;
  try {
    await deleteLead(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, "api/admin/leads", "Não foi possível excluir o formulário.");
  }
}
