import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { deleteFamilyUser, getUserById, updateFamilyUser } from "@/lib/data";
import { apiError } from "@/lib/api-error";
import { parseFamilyUpdate } from "@/lib/family-update";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = parseFamilyUpdate(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const family = await getUserById(id);
    if (!family || family.role !== "familia" || family.deleted_at) {
      return NextResponse.json({ error: "Família não encontrada." }, { status: 404 });
    }
    await updateFamilyUser(id, parsed.value);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, "api/admin/families/[id]", "Não foi possível salvar os dados da família.");
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole("admin");
  if ("error" in guard) return guard.error;

  const { id } = await params;
  try {
    await deleteFamilyUser(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, "api/admin/families", "Não foi possível excluir a conta da família.");
  }
}
