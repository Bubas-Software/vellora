import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { apiError } from "@/lib/api-error";
import {
  getContractDocument,
  isContractStorageKeyRegistered,
  registerStoredContractDocument,
} from "@/lib/data";
import { runtimeValue } from "@/lib/runtime-config";
import { resolveStorageProvider } from "@/lib/supabase/storage-config";
import {
  deleteSupabaseFile,
  inspectSupabaseFile,
  moveSupabaseFile,
} from "@/lib/supabase/storage";
import {
  CONTRACT_UPLOAD_MAX_BYTES,
  verifyContractUploadTicket,
} from "@/lib/contracts/direct-upload";
import { validateContractOwner } from "@/lib/contracts/owner-validation";

function isPdfSignature(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
}

export async function POST(request: NextRequest) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;
  if (resolveStorageProvider(runtimeValue("VELLORA_STORAGE_PROVIDER")) !== "supabase") {
    return NextResponse.json({ error: "Upload direto indisponível.", code: "direct_upload_disabled" }, { status: 404 });
  }

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

  const owner = await validateContractOwner(ticket.ownerType, ticket.ownerId);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });

  const finalPath = `contracts/${ticket.uploadId}.pdf`;
  let finalExists = false;
  try {
    // A retry after the database insert succeeded must return the same row even
    // if the browser did not receive the first response.
    const existing = await getContractDocument(ticket.uploadId);
    if (existing) return NextResponse.json({ ok: true, contract: existing });

    const pending = await inspectSupabaseFile(ticket.pendingPath);
    if (pending) {
      if (
        pending.bytes.byteLength !== ticket.fileSize ||
        pending.bytes.byteLength > CONTRACT_UPLOAD_MAX_BYTES ||
        pending.contentType !== "application/pdf" ||
        !isPdfSignature(pending.bytes)
      ) {
        await deleteSupabaseFile(ticket.pendingPath).catch(() => undefined);
        return NextResponse.json({ error: "O arquivo enviado não é um PDF válido ou excede o limite." }, { status: 400 });
      }
      await moveSupabaseFile(ticket.pendingPath, finalPath);
      finalExists = true;
    } else {
      const final = await inspectSupabaseFile(finalPath);
      if (!final) return NextResponse.json({ error: "Upload temporário não encontrado." }, { status: 404 });
      if (final.bytes.byteLength !== ticket.fileSize || final.contentType !== "application/pdf" || !isPdfSignature(final.bytes)) {
        await deleteSupabaseFile(finalPath).catch(() => undefined);
        return NextResponse.json({ error: "O arquivo armazenado não passou na validação." }, { status: 400 });
      }
      finalExists = true;
    }

    if (!finalExists) return NextResponse.json({ error: "Não foi possível confirmar o arquivo enviado." }, { status: 409 });
    const contract = await registerStoredContractDocument({
      id: ticket.uploadId,
      ownerType: ticket.ownerType,
      ownerId: ticket.ownerId,
      fileName: ticket.fileName,
      mimeType: ticket.mimeType,
      fileSize: ticket.fileSize,
      storageKey: finalPath,
      uploadedBy: ticket.uploadedBy,
    });
    return NextResponse.json({ ok: true, contract });
  } catch (error) {
    // Only remove an object that is not already represented in the database.
    // This preserves idempotent retries and avoids deleting another contract.
    if (finalExists && !(await isContractStorageKeyRegistered(finalPath).catch(() => false))) {
      await deleteSupabaseFile(finalPath).catch(() => undefined);
    }
    return apiError(error, "api/admin/contracts/finalize", "Não foi possível finalizar o contrato.");
  }
}
