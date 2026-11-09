import { NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { deactivateAssignment } from "@/lib/data";
import { apiError } from "@/lib/api-error";

export async function PATCH(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const { id } = await params;
  try {
    await deactivateAssignment(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, "api/admin/assignments", "Não foi possível encerrar o vínculo.");
  }
}
