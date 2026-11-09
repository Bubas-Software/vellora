import Link from "next/link";
import type { ContractDocument, Patient, User } from "@/lib/data";
import { ContractManager } from "@/components/admin/ContractManager";
import { DeleteButton } from "@/components/admin/DeleteButton";
import { CaregiverEditForm } from "@/components/admin/CaregiverEditForm";
import { Pill } from "@/components/ui/Badge";
import { PROFESSION_LABELS } from "@/components/admin/caregiver-directory";

type CaregiverAccount = Pick<User, "id" | "name" | "email" | "phone">;

export function CaregiverAccountDetails({
  caregiver,
  patients,
  contracts,
  canDelete,
}: {
  caregiver: CaregiverAccount;
  patients: Patient[];
  contracts: ContractDocument[];
  canDelete: boolean;
}) {
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
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--accent-dark)]">Cadastro manual</p>
          <h2 className="mt-1 break-words text-xl font-semibold text-[var(--foreground)]">{caregiver.name}</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">{caregiver.phone || "Telefone não informado"}</p>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-3 sm:items-end">
          <Pill value="ativo" />
          {canDelete ? (
            <DeleteButton
              endpoint={`/api/admin/caregiver-users/${caregiver.id}`}
              redirectTo="/admin/cuidadores"
              confirmText={`Excluir o cadastro de ${caregiver.name}? O acesso será encerrado, vínculos ativos serão removidos e os registros históricos serão preservados sem os dados pessoais.`}
              label="Excluir profissional"
            />
          ) : null}
        </div>
      </div>

      <CaregiverEditForm mode="manual" caregiver={caregiver} />

      <div className="grid gap-6 lg:grid-cols-2">
        <section
          aria-labelledby="manual-caregiver-data"
          className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6"
        >
          <h3 id="manual-caregiver-data" className="font-semibold text-[var(--foreground)]">Dados profissionais</h3>
          <dl className="mt-5 space-y-4">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">Profissão</dt>
              <dd className="mt-1 text-sm text-[var(--foreground)]">{PROFESSION_LABELS.cuidador}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">E-mail de acesso</dt>
              <dd className="mt-1 break-words text-sm text-[var(--foreground)]">{caregiver.email}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">Senha</dt>
              <dd className="mt-1 text-sm text-[var(--muted)]">Não exibida por segurança. Somente leitura.</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">Status</dt>
              <dd className="mt-1"><Pill value="ativo" /></dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">Telefone</dt>
              <dd className="mt-1 text-sm text-[var(--foreground)]">{caregiver.phone || "Não informado"}</dd>
            </div>
          </dl>
          <p className="mt-5 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-soft)] p-4 text-sm leading-6 text-[var(--muted)]">
            Este cadastro manual não possui candidatura aprovada associada nem outros dados profissionais registrados.
          </p>
        </section>

        <section
          aria-labelledby="manual-caregiver-availability"
          className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6"
        >
          <h3 id="manual-caregiver-availability" className="font-semibold text-[var(--foreground)]">Disponibilidade</h3>
          <p className="mt-5 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-soft)] p-4 text-sm leading-6 text-[var(--muted-2)]">
            Nenhuma disponibilidade foi informada para este cadastro manual.
          </p>
        </section>
      </div>

      <section
        aria-labelledby="manual-caregiver-patients"
        className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="manual-caregiver-patients" className="font-semibold text-[var(--foreground)]">Pacientes vinculados</h3>
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

      <ContractManager ownerType="caregiver_user" ownerId={caregiver.id} contracts={contracts} />
    </div>
  );
}
