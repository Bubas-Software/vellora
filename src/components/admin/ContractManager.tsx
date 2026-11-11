"use client";

import { Upload } from "tus-js-client";
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ContractDocument, ContractOwnerType } from "@/lib/data";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { reportClientMonitoringEvent } from "@/lib/monitoring-client";

const DIRECT_UPLOAD_MAX_BYTES = 10_000_000;
const LEGACY_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const DIRECT_UPLOAD_FALLBACK_CODES = new Set(["direct_upload_disabled", "direct_upload_unavailable"]);

type JsonObject = Record<string, unknown>;

type DirectUploadDetails = {
  tusEndpoint: string;
  token: string;
  path: string;
  ticket: string;
  expiresAt: string | number;
};

type UploadStatus = "idle" | "requesting" | "uploading" | "finalizing" | "canceling" | "success" | "error";

function formatBytes(value: number): string {
  return value < 1_000_000 ? `${Math.ceil(value / 1_000)} KB` : `${(value / 1_000_000).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(new Date(value));
}

async function readJson(response: Response): Promise<JsonObject | null> {
  const value: unknown = await response.json().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function responseError(result: JsonObject | null, fallback: string): string {
  const message = result?.error;
  return typeof message === "string" && message.length <= 240 ? message : fallback;
}

function shouldFallbackToLegacy(response: Response, result: JsonObject | null): boolean {
  return response.status === 404 || (typeof result?.code === "string" && DIRECT_UPLOAD_FALLBACK_CODES.has(result.code));
}

function isDirectUploadDetails(value: JsonObject | null): value is JsonObject & { ok: true } & DirectUploadDetails {
  return (
    value?.ok === true &&
    typeof value.tusEndpoint === "string" &&
    typeof value.token === "string" &&
    typeof value.path === "string" &&
    typeof value.ticket === "string" &&
    (typeof value.expiresAt === "string" || typeof value.expiresAt === "number")
  );
}

async function cancelDirectUpload(ticket: string): Promise<void> {
  await fetch("/api/admin/contracts/upload", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ ticket }),
  }).catch(() => undefined);
}

async function getSupabaseAccessToken(): Promise<string> {
  const {
    data: { session },
    error,
  } = await createSupabaseBrowserClient().auth.getSession();

  if (error || !session?.access_token) {
    throw new Error("Sua sessão expirou. Atualize a página e entre novamente.");
  }

  return session.access_token;
}

export function ContractManager({
  ownerType,
  ownerId,
  contracts,
}: {
  ownerType: ContractOwnerType;
  ownerId: string;
  contracts: ContractDocument[];
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const uploadRef = useRef<Upload | null>(null);
  const ticketRef = useRef<string | null>(null);
  const cancellationRequestedRef = useRef(false);
  const fileInputId = useId();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const busy = status === "requesting" || status === "uploading" || status === "finalizing" || status === "canceling";

  useEffect(() => {
    return () => {
      cancellationRequestedRef.current = true;
      const activeUpload = uploadRef.current;
      if (activeUpload) void activeUpload.abort(true).catch(() => undefined);
      const ticket = ticketRef.current;
      if (ticket) void cancelDirectUpload(ticket);
    };
  }, []);

  function clearMessages() {
    setError(null);
    setNotice(null);
  }

  function resetFileInput() {
    formRef.current?.reset();
    setSelectedFile(null);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    clearMessages();
    setProgress(0);
    const file = event.target.files?.[0] || null;
    if (!file) {
      setSelectedFile(null);
      return;
    }

    const isPdf = file.type === "application/pdf" || (file.type === "" && file.name.toLowerCase().endsWith(".pdf"));
    if (!isPdf || !file.name.toLowerCase().endsWith(".pdf")) {
      event.target.value = "";
      setSelectedFile(null);
      setError("Envie somente um arquivo PDF.");
      return;
    }
    if (file.size > DIRECT_UPLOAD_MAX_BYTES) {
      event.target.value = "";
      setSelectedFile(null);
      setError("O contrato deve ter no máximo 10 MB.");
      return;
    }
    setSelectedFile(file);
  }

  async function requestDirectUpload(file: File): Promise<DirectUploadDetails | null> {
    const response = await fetch("/api/admin/contracts/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        ownerType,
        ownerId,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || "application/pdf",
      }),
    });
    const result = await readJson(response);
    if (shouldFallbackToLegacy(response, result)) return null;
    if (!response.ok) throw new Error(responseError(result, "Não foi possível preparar o envio do contrato."));
    if (!isDirectUploadDetails(result)) throw new Error("A resposta do envio direto do contrato é inválida.");
    return {
      tusEndpoint: result.tusEndpoint,
      token: result.token,
      path: result.path,
      ticket: result.ticket,
      expiresAt: result.expiresAt,
    };
  }

  async function uploadWithTus(file: File, details: DirectUploadDetails): Promise<void> {
    const accessToken = await getSupabaseAccessToken();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };

      const upload = new Upload(file, {
        endpoint: details.tusEndpoint,
        headers: {
          // The signed upload token authorizes only this object and belongs in
          // x-signature. Authorization must carry the current Supabase user
          // token so Storage RLS can verify the administrator identity.
          Authorization: `Bearer ${accessToken}`,
          "x-signature": details.token,
        },
        metadata: {
          bucketName: "contracts",
          objectName: details.path,
          contentType: "application/pdf",
        },
        chunkSize: 6 * 1024 * 1024,
        retryDelays: [0, 3000, 5000, 10000, 20000],
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        onProgress: (bytesSent, bytesTotal) => {
          setProgress(bytesTotal > 0 ? Math.min(99, Math.round((bytesSent / bytesTotal) * 100)) : 0);
        },
        onError: () => {
          reportClientMonitoringEvent("SUPABASE_SERVICE_ERROR", "TusUploadError", "/admin");
          finish(() => reject(new Error("Não foi possível enviar o contrato.")));
        },
        onSuccess: () => {
          finish(resolve);
        },
      });

      uploadRef.current = upload;
      try {
        upload.start();
      } catch {
        reportClientMonitoringEvent("SUPABASE_SERVICE_ERROR", "TusUploadStartError", "/admin");
        finish(() => reject(new Error("Não foi possível iniciar o envio do contrato.")));
      }
    });
  }

  async function uploadLegacy(file: File): Promise<void> {
    if (file.size > LEGACY_UPLOAD_MAX_BYTES) {
      throw new Error("O envio direto está indisponível no momento. O fluxo alternativo aceita contratos de até 4 MiB.");
    }

    setStatus("uploading");
    setProgress(0);
    const data = new FormData();
    data.append("owner_type", ownerType);
    data.append("owner_id", ownerId);
    data.append("file", file, file.name);
    const response = await fetch("/api/admin/contracts", {
      method: "POST",
      credentials: "same-origin",
      body: data,
    });
    const result = await readJson(response);
    if (!response.ok) throw new Error(responseError(result, "Não foi possível anexar o contrato."));
    setProgress(100);
    setStatus("success");
    setNotice("Contrato anexado com sucesso.");
    resetFileInput();
    router.refresh();
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const file = selectedFile || event.currentTarget.elements.namedItem("file");
    const selected = file instanceof HTMLInputElement ? file.files?.[0] || null : selectedFile;
    if (!selected) {
      setError("Escolha um contrato em PDF para continuar.");
      return;
    }
    if (selected.size > DIRECT_UPLOAD_MAX_BYTES) {
      setError("O contrato deve ter no máximo 10 MB.");
      return;
    }

    cancellationRequestedRef.current = false;
    clearMessages();
    setProgress(0);
    setStatus("requesting");

    try {
      const details = await requestDirectUpload(selected);
      if (cancellationRequestedRef.current) return;

      if (!details) {
        await uploadLegacy(selected);
        return;
      }

      ticketRef.current = details.ticket;
      setStatus("uploading");
      await uploadWithTus(selected, details);
      if (cancellationRequestedRef.current) return;

      setStatus("finalizing");
      const finalizeResponse = await fetch("/api/admin/contracts/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ticket: details.ticket }),
      });
      const finalizeResult = await readJson(finalizeResponse);
      if (!finalizeResponse.ok || finalizeResult?.ok !== true) {
        throw new Error(responseError(finalizeResult, "Não foi possível concluir o envio do contrato."));
      }

      ticketRef.current = null;
      setProgress(100);
      setStatus("success");
      setNotice("Contrato anexado com sucesso.");
      resetFileInput();
      router.refresh();
    } catch (uploadError) {
      if (cancellationRequestedRef.current) return;
      const ticket = ticketRef.current;
      if (ticket) {
        await cancelDirectUpload(ticket);
        ticketRef.current = null;
      }
      setStatus("error");
      setError(uploadError instanceof Error ? uploadError.message : "Erro ao anexar o contrato.");
    } finally {
      uploadRef.current = null;
    }
  }

  async function cancelUpload() {
    if (!busy) return;
    cancellationRequestedRef.current = true;
    setStatus("canceling");
    setError(null);
    const activeUpload = uploadRef.current;
    if (activeUpload) await activeUpload.abort(true).catch(() => undefined);
    const ticket = ticketRef.current;
    if (ticket) {
      await cancelDirectUpload(ticket);
      ticketRef.current = null;
    }
    uploadRef.current = null;
    setProgress(0);
    setStatus("idle");
    setNotice("Envio do contrato cancelado.");
    resetFileInput();
  }

  async function remove(id: string, fileName: string) {
    if (!window.confirm(`Excluir o contrato “${fileName}”? Esta ação não pode ser desfeita.`)) return;
    setStatus("requesting");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/contracts/${id}`, { method: "DELETE", credentials: "same-origin" });
      const result = await readJson(response);
      if (!response.ok) throw new Error(responseError(result, "Não foi possível excluir o contrato."));
      router.refresh();
    } catch (removalError) {
      setStatus("error");
      setError(removalError instanceof Error ? removalError.message : "Erro ao excluir o contrato.");
    } finally {
      setStatus((current) => (current === "requesting" ? "idle" : current));
    }
  }

  return (
    <section className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--surface-soft)] p-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h4 className="text-sm font-semibold text-[var(--foreground)]">Contratos assinados</h4>
          <p className="text-xs text-[var(--muted)]">PDF de até 10 MB. O titular pode apenas visualizar.</p>
        </div>
      </div>

      {contracts.length ? (
        <ul className="mt-3 space-y-2">
          {contracts.map((contract) => (
            <li key={contract.id} className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-white px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <a
                  href={`/api/contracts/${contract.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block truncate text-sm font-semibold text-[var(--brand)] hover:underline"
                >
                  {contract.file_name}
                </a>
                <p className="text-xs text-[var(--muted-2)]">{formatBytes(contract.file_size)} · {formatDate(contract.created_at)}</p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => remove(contract.id, contract.file_name)}
                className="text-xs font-semibold text-[var(--status-critical)] hover:underline disabled:opacity-50"
              >
                Excluir contrato
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-[var(--muted-2)]">Nenhum contrato anexado.</p>
      )}

      <form ref={formRef} onSubmit={upload} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor={fileInputId} className="sr-only">Escolher contrato em PDF</label>
          <input
            id={fileInputId}
            type="file"
            name="file"
            accept="application/pdf,.pdf"
            required
            disabled={busy}
            onChange={handleFileChange}
            className="block min-h-10 w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-xs text-[var(--muted)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--brand-light)] file:px-3 file:py-1.5 file:font-semibold file:text-[var(--brand-dark)] disabled:opacity-50"
          />
          <p className="mt-1 text-[11px] text-[var(--muted-2)]">PDF de até 10 MB{selectedFile ? ` · ${formatBytes(selectedFile.size)}` : ""}.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy || !selectedFile}
            className="min-h-10 rounded-lg bg-[var(--brand-dark)] px-4 text-xs font-semibold text-white hover:bg-[var(--brand-deep)] disabled:opacity-50"
          >
            {status === "requesting" ? "Preparando..." : status === "uploading" ? `Enviando ${progress}%` : status === "finalizing" ? "Concluindo..." : "Anexar contrato"}
          </button>
          {busy ? (
            <button
              type="button"
              onClick={() => void cancelUpload()}
              disabled={status === "canceling"}
              className="min-h-10 rounded-lg border border-[var(--border)] bg-white px-4 text-xs font-semibold text-[var(--foreground)] hover:bg-[var(--surface)] disabled:opacity-50"
            >
              {status === "canceling" ? "Cancelando..." : "Cancelar"}
            </button>
          ) : null}
        </div>
      </form>

      {status === "uploading" ? (
        <div className="mt-2" role="status" aria-live="polite" aria-atomic="true">
          <div className="h-2 overflow-hidden rounded-full bg-[var(--border)]" role="progressbar" aria-label="Progresso do envio do contrato" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div className="h-full rounded-full bg-[var(--brand)] transition-[width]" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1 text-xs text-[var(--muted)]">Enviando contrato diretamente para o armazenamento seguro...</p>
        </div>
      ) : null}
      {status === "finalizing" ? <p className="mt-2 text-xs text-[var(--muted)]" role="status" aria-live="polite">Validando e registrando o contrato...</p> : null}
      {notice ? <p className="mt-2 text-xs text-[var(--brand-dark)]" role="status" aria-live="polite">{notice}</p> : null}
      {error ? <p className="mt-2 text-xs text-[var(--status-critical)]" role="alert">{error}</p> : null}
    </section>
  );
}
