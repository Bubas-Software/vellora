import { beforeEach, describe, expect, it } from "vitest";
import {
  CONTRACT_UPLOAD_MAX_BYTES,
  createContractUploadTicket,
  validateContractUploadMetadata,
  verifyContractUploadTicket,
} from "../src/lib/contracts/direct-upload";

const uploadId = "44444444-4444-4444-8444-444444444444";
const ownerId = "11111111-1111-4111-8111-111111111111";
const adminId = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  process.env.VELLORA_SESSION_SECRET = "test-session-secret-for-contract-upload";
});

describe("upload direto de contratos", () => {
  it("aceita exatamente 10 MB e rejeita o que ultrapassa o limite", () => {
    expect(
      validateContractUploadMetadata({
        ownerType: "family",
        ownerId,
        fileName: "contrato.pdf",
        fileSize: CONTRACT_UPLOAD_MAX_BYTES,
        mimeType: "application/pdf",
      }),
    ).toMatchObject({ ok: true, fileSize: CONTRACT_UPLOAD_MAX_BYTES });

    expect(
      validateContractUploadMetadata({
        ownerType: "family",
        ownerId,
        fileName: "contrato.pdf",
        fileSize: CONTRACT_UPLOAD_MAX_BYTES + 1,
        mimeType: "application/pdf",
      }),
    ).toEqual({ ok: false, error: "O contrato deve ter no máximo 10 MB." });
  });

  it("rejeita tipos, nomes e proprietários inválidos", () => {
    for (const input of [
      { ownerType: "family", ownerId, fileName: "contrato.pdf", fileSize: 10, mimeType: "image/png" },
      { ownerType: "family", ownerId, fileName: "contrato.exe", fileSize: 10, mimeType: "application/pdf" },
      { ownerType: "invalid", ownerId, fileName: "contrato.pdf", fileSize: 10, mimeType: "application/pdf" },
      { ownerType: "family", ownerId: "not-a-uuid", fileName: "contrato.pdf", fileSize: 10, mimeType: "application/pdf" },
    ]) {
      expect(validateContractUploadMetadata(input)).toMatchObject({ ok: false });
    }
  });

  it("assina e verifica um ticket vinculado ao caminho e à sessão", async () => {
    const ticket = {
      uploadId,
      ownerType: "family" as const,
      ownerId,
      fileName: "contrato do paciente.pdf",
      fileSize: 4096,
      mimeType: "application/pdf" as const,
      pendingPath: `contracts/pending/${uploadId}.pdf`,
      uploadedBy: adminId,
    };
    const signed = await createContractUploadTicket(ticket);
    await expect(verifyContractUploadTicket(signed)).resolves.toEqual(ticket);

    const signatureSeparator = signed.lastIndexOf(".");
    const signature = signed.slice(signatureSeparator + 1);
    const changedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const tampered = `${signed.slice(0, signatureSeparator + 1)}${changedSignature}`;
    await expect(verifyContractUploadTicket(tampered)).resolves.toBeNull();
  });
});
