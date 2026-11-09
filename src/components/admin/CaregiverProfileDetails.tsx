"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CaregiverProfile, ContractDocument, Patient } from "@/lib/data";
import { ContractManager } from "@/components/admin/ContractManager";
import { DeleteButton } from "@/components/admin/DeleteButton";
import { CaregiverEditForm } from "@/components/admin/CaregiverEditForm";
import { Pill } from "@/components/ui/Badge";
import {
  DAY_LABELS,
  PROFESSION_LABELS,
  SHIFT_LABELS,
} from "@/components/admin/caregiver-directory";

function formatDate(value: string | null): string {
  if (!value) return "Não informada";
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(date);
}

function formatList(values: string[], labels: Record<string, string>, emptyMessage: string): string {
  return values.length ? values.map((value) => labels[value] || value).join(", ") : emptyMessage;
}

export function CaregiverProfileDetails({
  profile,
  patients,
  contracts,
  canDelete,
}: {
  profile: CaregiverProfile;
  patients: Patient[];
  contracts: ContractDocument[];
  canDelete: boolean;
}) {
  const router = useRouter();
  const [accessFormOpen, setAccessFormOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/caregivers/${profile.id}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: data.get("email"),
          password: data.get("password"),
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Não foi possível criar o acesso.");
      setAccessFormOpen(false);
      router.refresh();
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Erro ao criar acesso.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-4xl">
      <Link
        href="/admin/cuidadores"
        className="text-sm text-[var(--muted)] underline-offset-4 hover:text-[var(--foreground)] hover:underline focus-visible:rounded-sm"
      >
        ← Cuidadores
      </Link>

      <div className="mt-4 mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--accent-dark)]">
            {profile.application_id ? "Perfil aprovado" : "Cadastro manual"}
          </p>
          <h2 className="mt-1 break-words text-xl font-semibold text-[var(--foreground)]">{profile.name}</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">{profile.phone || "Telefone não informado"}</p>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-3 sm:items-end">
          <Pill value={profile.account_status} />
          {canDelete ? (
            <DeleteButton
              endpoint={`/api/admin/caregivers/${profile.id}`}
              redirectTo="/admin/cuidadores"
              confirmText={`Excluir o cadastro de ${profile.name}? O acesso será encerrado, vínculos ativos serão removidos e os registros históricos serão preservados sem os dados pessoais do profissional.`}
              label="Excluir profissional"
            />
          ) : null}
        </div>
      </div>

      <CaregiverEditForm mode="profile" caregiver={profile} />

      <div className="grid gap-6 lg:grid-cols-2">
        <section
          aria-labelledby="caregiver-professional-data"
          className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6"
        >
          <h3 id="caregiver-professional-data" className="font-semibold text-[var(--foreground)]">
            Dados profissionais
          </h3>
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">Profissão</dt>
              <dd className="mt-1 text-sm text-[var(--foreground)]">{PROFESSION_LABELS[profile.profession]}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">COREN</dt>
              <dd className="mt-1 text-sm text-[var(--foreground)]">{profile.coren || "Não informado"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">E-mail de contato</dt>
              <dd className="mt-1 break-words text-sm text-[var(--foreground)]">{profile.contact_email}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">Cidade</dt>
              <dd className="mt-1 text-sm text-[var(--foreground)]">{profile.city || "Não informada"}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">Experiência</dt>
              <dd className="mt-1 whitespace-pre-wrap text-sm leading-6 text-[var(--foreground)]">
                {profile.experience || "Não informada"}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">Observações</dt>
              <dd className="mt-1 whitespace-pre-wrap text-sm leading-6 text-[var(--foreground)]">
                {profile.notes || "Nenhuma observação registrada."}
              </dd>
            </div>
          </dl>
        </section>

        <section
          aria-labelledby="caregiver-availability"
          className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6"
        >
          <h3 id="caregiver-availability" className="font-semibold text-[var(--foreground)]">
            Disponibilidade
          </h3>
          <dl className="mt-5 space-y-4">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">Dias</dt>
              <dd className="mt-1 text-sm text-[var(--foreground)]">
                {formatList(profile.availability_days, DAY_LABELS, "Nenhum dia informado.")}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">Turnos</dt>
              <dd className="mt-1 text-sm text-[var(--foreground)]">
                {formatList(profile.availability_shifts, SHIFT_LABELS, "Nenhum turno informado.")}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">Disponível a partir de</dt>
              <dd className="mt-1 text-sm text-[var(--foreground)]">{formatDate(profile.available_from)}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section
        aria-labelledby="caregiver-patients"
        className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="caregiver-patients" className="font-semibold text-[var(--foreground)]">
            Pacientes vinculados
          </h3>
          <span className="text-xs text-[var(--muted-2)]">{patients.length} vinculados</span>
        </div>
        {patients.length ? (
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {patients.map((patient) => (
              <li key={patient.id} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-soft)] px-3 py-3">
                <Link
                  href={`/admin/pacientes/${patient.id}`}
                  className="min-w-0 break-words text-sm font-semibold text-[var(--brand)] underline-offset-4 hover:underline focus-visible:rounded-sm"
                >
                  {patient.name}
                </Link>
                <Pill value={patient.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-soft)] p-4 text-sm text-[var(--muted-2)]">
            Nenhum paciente vinculado.
          </p>
        )}
      </section>

      <section aria-labelledby="caregiver-actions" className="mt-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 id="caregiver-actions" className="font-semibold text-[var(--foreground)]">Ações e acesso</h3>
            <p className="mt-1 text-sm text-[var(--muted)]">Ações existentes do banco de profissionais.</p>
          </div>
          {profile.account_status === "aguardando_acesso" && !profile.user_id ? (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setAccessFormOpen((open) => !open);
              }}
              className="min-h-10 rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--brand-dark)]"
            >
              {accessFormOpen ? "Cancelar" : "Criar e-mail e senha"}
            </button>
          ) : null}
        </div>

        {accessFormOpen ? (
          <form
            onSubmit={createAccess}
            className="mt-4 grid gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-soft)] p-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto] lg:items-end"
          >
            <div>
              <label htmlFor={`access-email-${profile.id}`} className="block text-xs font-medium text-[var(--muted)]">
                E-mail de acesso *
              </label>
              <input
                id={`access-email-${profile.id}`}
                name="email"
                type="email"
                required
                defaultValue={profile.contact_email}
                autoComplete="off"
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2.5 text-sm"
              />
            </div>
            <div>
              <label htmlFor={`access-password-${profile.id}`} className="block text-xs font-medium text-[var(--muted)]">
                Senha provisória *
              </label>
              <input
                id={`access-password-${profile.id}`}
                name="password"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                placeholder="Mínimo de 12 caracteres"
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2.5 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="min-h-10 rounded-lg bg-[var(--brand-dark)] px-5 text-sm font-semibold text-white hover:bg-[var(--brand-deep)] disabled:opacity-50"
            >
              {loading ? "Criando..." : "Ativar acesso"}
            </button>
            {error ? (
              <p className="text-sm text-[var(--status-critical)] sm:col-span-2 lg:col-span-3" role="alert">
                {error}
              </p>
            ) : null}
            <p className="text-xs leading-5 text-[var(--muted-2)] sm:col-span-2 lg:col-span-3">
              Oriente o profissional a trocar a senha provisória usando “Esqueci minha senha” após o primeiro acesso.
            </p>
          </form>
        ) : null}
      </section>

      <ContractManager ownerType="caregiver_profile" ownerId={profile.id} contracts={contracts} />
    </div>
  );
}
