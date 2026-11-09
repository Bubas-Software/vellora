import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getContractDocument, getContractFileData, getCaregiverProfile } from "@/lib/data";
import { apiError } from "@/lib/api-error";

function safeFileName(value: string): string {
  return value.replace(/[\r\n"]/g, " ").slice(0, 180) || "contrato.pdf";
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const { id } = await params;
  const contract = await getContractDocument(id);
  if (!contract) return NextResponse.json({ error: "Contrato não encontrado." }, { status: 404 });

  let authorized = session.role === "admin" || session.role === "coordenador_operacional";
  if (session.role === "familia") {
    authorized = contract.family_user_id === session.userId;
  }
  if (session.role === "cuidador") {
    authorized = contract.caregiver_user_id === session.userId;
    if (!authorized && contract.caregiver_profile_id) {
      const profile = await getCaregiverProfile(contract.caregiver_profile_id);
      authorized = profile?.user_id === session.userId;
    }
  }
  if (!authorized) return NextResponse.json({ error: "Sem permissão." }, { status: 403 });

  let fileData: Uint8Array | null;
  try {
    fileData = await getContractFileData(id);
  } catch (error) {
    return apiError(error, "api/contracts", "Não foi possível abrir o contrato agora.");
  }
  if (!fileData) return NextResponse.json({ error: "Arquivo do contrato não encontrado." }, { status: 404 });

  const fileName = safeFileName(contract.file_name);
  return new NextResponse(new Uint8Array(fileData), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
