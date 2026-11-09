import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { setCoordinatorAccountActive } from "@/lib/data";
import { apiError } from "@/lib/api-error";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole("admin");
  if ("error" in guard) return guard.error;

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "Conta inválida." }, { status: 400 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (typeof body?.active !== "boolean") {
    return NextResponse.json({ error: "Informe se o acesso ficará ativo." }, { status: 400 });
  }

  try {
    await setCoordinatorAccountActive(id, body.active);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, "api/admin/coordinators", "Não foi possível atualizar a conta da coordenação.");
  }
}
