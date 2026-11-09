import type { FamilyContractedService, Patient } from "@/lib/data";
import { PROFESSION_LABELS } from "@/components/schedules/date-utils";

export function FamilyContractedServicesSummary({
  patients,
  services,
}: {
  patients: Pick<Patient, "id" | "name">[];
  services: FamilyContractedService[];
}) {
  const serviceByPatient = new Map<string, Set<string>>();
  for (const service of services) {
    const current = serviceByPatient.get(service.patient_id) || new Set<string>();
    current.add(PROFESSION_LABELS[service.profession]);
    serviceByPatient.set(service.patient_id, current);
  }

  return (
    <section className="mt-8" aria-labelledby="family-contracted-services-heading">
      <h2 id="family-contracted-services-heading" className="text-lg font-semibold text-[var(--foreground)]">
        Serviços contratados
      </h2>
      <p className="mt-1 text-sm text-[var(--muted)]">Os valores por plantão são gerenciados pelo Administrador.</p>
      {patients.length ? (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {patients.map((patient) => {
            const labels = [...(serviceByPatient.get(patient.id) || [])];
            return (
              <li key={patient.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <h3 className="font-semibold text-[var(--foreground)]">{patient.name}</h3>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  {labels.length ? labels.join(" · ") : "Nenhum serviço configurado"}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-[var(--muted)]">Nenhum paciente vinculado a esta família.</p>
      )}
    </section>
  );
}
