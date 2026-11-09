import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { apiError } from "@/lib/api-error";
import { runtimeValue } from "@/lib/runtime-config";
import { resolveStorageProvider } from "@/lib/supabase/storage-config";
import { createSupabaseSignedUploadUrl } from "@/lib/supabase/storage";
import {
  CONTRACT_UPLOAD_PENDING_PREFIX,
  createContractUploadTicket,
  isDirectContractUploadEnabled,
  validateContractUploadMetadata,
} from "@/lib/contracts/direct-upload";
import { validateContractOwner } from "@/lib/contracts/owner-validation";

export async function POST(request: NextRequest) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  if (
    !isDirectContractUploadEnabled() ||
    resolveStorageProvider(runtimeValue("VELLORA_STORAGE_PROVIDER")) !== "supabase"
  ) {
    return NextResponse.json(
      { error: "Upload direto indisponível para este ambiente.", code: "direct_upload_disabled" },
      { status: 404 },
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Metadados do upload inválidos." }, { status: 400 });
  }

  const metadata = validateContractUploadMetadata({
    ownerType: body.ownerType ?? body.owner_type,
    ownerId: body.ownerId ?? body.owner_id,
    fileName: body.fileName ?? body.file_name,
    fileSize: body.fileSize ?? body.file_size,
    mimeType: body.mimeType ?? body.mime_type,
  });
  if (!metadata.ok) return NextResponse.json({ error: metadata.error }, { status: 400 });

  const owner = await validateContractOwner(metadata.ownerType, metadata.ownerId);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });

  const uploadId = randomUUID();
  const pendingPath = `${CONTRACT_UPLOAD_PENDING_PREFIX}${uploadId}.pdf`;
  try {
    const target = await createSupabaseSignedUploadUrl(pendingPath, "application/pdf");
    const ticket = await createContractUploadTicket({
      uploadId,
      ownerType: metadata.ownerType,
      ownerId: metadata.ownerId,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      mimeType: "application/pdf",
      pendingPath,
      uploadedBy: guard.session.userId,
    });
    return NextResponse.json({
      ok: true,
      tusEndpoint: target.uploadEndpoint,
      token: target.token,
      path: pendingPath,
      ticket,
      expiresAt: target.expiresAt,
    });
  } catch (error) {
    return apiError(error, "api/admin/contracts/upload-url", "Não foi possível preparar o upload do contrato.");
  }
}

