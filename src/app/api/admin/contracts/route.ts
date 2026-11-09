import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import {
  createContractDocument,
  getCaregiverProfile,
  getUserById,
  type ContractOwnerType,
} from "@/lib/data";
import { apiError } from "@/lib/api-error";

const MAX_FILE_SIZE = 4 * 1024 * 1024;
const OWNER_TYPES: ContractOwnerType[] = ["family", "caregiver_profile", "caregiver_user"];

export async function POST(req: NextRequest) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const formData = await req.formData().catch(() => null);
  if (!formData) return NextResponse.json({ error: "Envio inválido." }, { status: 400 });

  const ownerType = String(formData.get("owner_type") || "") as ContractOwnerType;
  const ownerId = String(formData.get("owner_id") || "").trim();
  const file = formData.get("file");
  if (!OWNER_TYPES.includes(ownerType) || !ownerId || !(file instanceof File)) {
    return NextResponse.json({ error: "Selecione o cadastro e o arquivo PDF." }, { status: 400 });
  }
  if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "O contrato deve ter no máximo 4 MiB." }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const isPdf = file.name.toLowerCase().endsWith(".pdf") && bytes.subarray(0, 5).toString() === "%PDF-";
  if (!isPdf) {
    return NextResponse.json({ error: "Envie somente um contrato em PDF válido." }, { status: 400 });
  }

  if (ownerType === "family") {
    const user = await getUserById(ownerId);
    if (!user || user.role !== "familia" || user.deleted_at) {
      return NextResponse.json({ error: "Conta da família não encontrada." }, { status: 404 });
    }
  } else if (ownerType === "caregiver_profile") {
    if (!(await getCaregiverProfile(ownerId))) {
      return NextResponse.json({ error: "Cadastro profissional não encontrado." }, { status: 404 });
    }
  } else {
    const user = await getUserById(ownerId);
    if (!user || user.role !== "cuidador" || user.deleted_at) {
      return NextResponse.json({ error: "Conta do cuidador não encontrada." }, { status: 404 });
    }
  }

  try {
    const contract = await createContractDocument({
      ownerType,
      ownerId,
      fileName: file.name.replace(/[\r\n"]/g, " ").slice(0, 180),
      mimeType: "application/pdf",
      fileSize: file.size,
      fileData: bytes,
      uploadedBy: guard.session.userId,
    });
    return NextResponse.json({ ok: true, contract });
  } catch (error) {
    return apiError(error, "api/admin/contracts", "Não foi possível enviar o contrato.");
  }
}
