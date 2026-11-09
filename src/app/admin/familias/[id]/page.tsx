import Link from "next/link";
import { notFound } from "next/navigation";
import { ContractManager } from "@/components/admin/ContractManager";
import { FamilyContractedServicesSummary } from "@/components/admin/FamilyContractedServicesSummary";
import { DeleteButton } from "@/components/admin/DeleteButton";
import { FamilyEditForm } from "@/components/admin/FamilyEditForm";
import { FamilyPatientServiceRatesManager } from "@/components/admin/FamilyPatientServiceRatesManager";
import { Card } from "@/components/ui/Card";
import {
  getUserById,
  listContractDocuments,
  listFamilyPatientServiceRates,
  listFamilyContractedServices,
  listPatientsByFamily,
  type FamilyPatientServiceRate,
} from "@/lib/data";
import { getSession } from "@/lib/auth";

function isMissingFamilyServiceRatesTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === "PGRST205") return true;
  if (typeof candidate.message !== "string") return false;
  const message = candidate.message.toLowerCase();
  return message.includes("family_patient_service_rates")
    && (message.includes("schema cache") || message.includes("does not exist"));
}

export default async function AdminFamilyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const isAdmin = session?.role === "admin";
  const family = await getUserById(id);

  if (!family || family.role !== "familia" || family.deleted_at) notFound();

  const [patients, contracts] = await Promise.all([
    listPatientsByFamily(family.id),
    listContractDocuments("family", family.id),
  ]);
  let rates: FamilyPatientServiceRate[] = [];
  let contractedServices: Awaited<ReturnType<typeof listFamilyContractedServices>> = [];
  let serviceRatesAvailable = true;
  if (isAdmin) {
    try {
      rates = await listFamilyPatientServiceRates(family.id);
    } catch (error) {
      if (!isMissingFamilyServiceRatesTable(error)) throw error;
      serviceRatesAvailable = false;
    }
  } else {
    contractedServices = await listFamilyContractedServices(family.id);
  }
  const todayParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const todayValues = Object.fromEntries(todayParts.map((part) => [part.type, part.value]));
  const today = `${todayValues.year}-${todayValues.month}-${todayValues.day}`;

  return (
    <div className="max-w-4xl">
      <Link href="/admin/familias" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
        ← Famílias
      </Link>

      <div className="mt-4 mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm text-[var(--muted)]">Detalhe da família</p>
          <h1 className="mt-1 text-2xl font-semibold text-[var(--foreground)]">{family.name}</h1>
        </div>
        {isAdmin ? (
          <DeleteButton
            endpoint={`/api/admin/families/${family.id}`}
            redirectTo="/admin/familias"
            label="Excluir família"
            confirmText={`Excluir a família ${family.name}? A conta será removida, os contratos serão apagados e os pacientes ficarão sem vínculo familiar. Os registros de cuidado serão preservados.`}
          />
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="font-semibold text-[var(--foreground)]">Contato</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="text-[var(--muted-2)]">E-mail</dt>
              <dd className="mt-1 break-words text-[var(--foreground)]">{family.email}</dd>
            </div>
            <div>
              <dt className="text-[var(--muted-2)]">Telefone</dt>
              <dd className="mt-1 text-[var(--foreground)]">{family.phone || "Não informado"}</dd>
            </div>
          </dl>
          <FamilyEditForm family={family} />
        </Card>

        <Card>
          <h2 className="font-semibold text-[var(--foreground)]">Pacientes vinculados</h2>
          {patients.length ? (
            <ul className="mt-4 space-y-2">
              {patients.map((patient) => (
                <li key={patient.id}>
                  <Link href={`/admin/pacientes/${patient.id}`} className="text-sm font-semibold text-[var(--brand)] hover:underline">
                    {patient.name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-4 space-y-1 text-sm text-[var(--muted-2)]">
              <p>Nenhum paciente vinculado a esta família.</p>
              <p>Abra o cadastro de um paciente para selecionar esta família em <strong>Conta da família</strong>.</p>
              <Link href="/admin/pacientes" className="inline-block pt-1 font-semibold text-[var(--brand)] hover:underline">
                Ver pacientes
              </Link>
            </div>
          )}
        </Card>
      </div>

      {isAdmin ? (
        <FamilyPatientServiceRatesManager
          familyId={family.id}
          patients={patients}
          rates={rates}
          today={today}
          available={serviceRatesAvailable}
        />
      ) : (
        <FamilyContractedServicesSummary patients={patients} services={contractedServices} />
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-[var(--foreground)]">Contratos</h2>
        <ContractManager ownerType="family" ownerId={family.id} contracts={contracts} />
      </section>
    </div>
  );
}
