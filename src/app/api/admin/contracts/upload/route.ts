import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { deleteSupabaseFile } from "@/lib/supabase/storage";
import { verifyContractUploadTicket } from "@/lib/contracts/direct-upload";

export async function DELETE(request: NextRequest) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Ticket de upload inválido." }, { status: 400 });
  }

  const ticket = await verifyContractUploadTicket(body.ticket);
  if (!ticket) return NextResponse.json({ error: "Ticket inválido ou expirado." }, { status: 400 });
  if (ticket.uploadedBy !== guard.session.userId) {
    return NextResponse.json({ error: "Este upload pertence a outra sessão administrativa." }, { status: 403 });
  }

  try {
    await deleteSupabaseFile(ticket.pendingPath);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[api/admin/contracts/upload] Falha ao cancelar upload", {
      error: error instanceof Error ? error.message : "Erro desconhecido",
    });
    return NextResponse.json({ error: "Não foi possível cancelar o upload." }, { status: 503 });
  }
}

