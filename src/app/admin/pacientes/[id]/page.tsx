import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getPatient,
  getUserById,
  listUsersByRole,
  listAssignmentsForPatient,
  listRecordsForPatient,
  getCaregiverNamesMap,
} from "@/lib/data";
import { EditPatientForm } from "@/components/admin/EditPatientForm";
import { AssignmentsManager } from "@/components/admin/AssignmentsManager";
import { RecordCard } from "@/components/RecordCard";
import { Card } from "@/components/ui/Card";
import { DeleteButton } from "@/components/admin/DeleteButton";
import { getSession } from "@/lib/auth";

export default async function AdminPatientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const isAdmin = session?.role === "admin";
  const patient = await getPatient(id);
  if (!patient) notFound();

  const [currentFamily, familyUsers, caregivers, assignmentsRaw, records] = await Promise.all([
    patient.family_user_id ? getUserById(patient.family_user_id) : Promise.resolve(undefined),
    listUsersByRole("familia"),
    listUsersByRole("cuidador"),
    listAssignmentsForPatient(patient.id),
    listRecordsForPatient(patient.id, 10),
  ]);

  const nameIds = [...assignmentsRaw.map((a) => a.caregiver_user_id), ...records.map((r) => r.caregiver_user_id)];
  const namesMap = await getCaregiverNamesMap(nameIds);
  const assignments = assignmentsRaw.map((a) => ({ ...a, caregiverName: namesMap[a.caregiver_user_id] || "Cuidador" }));

  return (
    <div className="max-w-4xl">
      <Link href="/admin/pacientes" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
        ← Pacientes
      </Link>
      <div className="mt-4 mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold text-[var(--foreground)]">{patient.name}</h2>
        {isAdmin ? (
          <DeleteButton
            endpoint={`/api/admin/patients/${patient.id}`}
            redirectTo="/admin/pacientes"
            label="Excluir paciente"
            confirmText={`Excluir ${patient.name}? Os vínculos com cuidadores e os registros diários desse paciente também serão apagados. A conta da família será preservada.`}
          />
        ) : null}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <h3 className="font-semibold text-[var(--foreground)] mb-4">Editar paciente</h3>
          <EditPatientForm patient={patient} familyUsers={familyUsers} currentFamily={currentFamily} />
        </Card>

        <Card>
          <h3 className="font-semibold text-[var(--foreground)] mb-4">Cuidadores vinculados</h3>
          <AssignmentsManager patientId={patient.id} assignments={assignments} caregivers={caregivers} />
        </Card>
      </div>

      <h3 className="mt-10 mb-4 text-lg font-semibold text-[var(--foreground)]">Últimos registros diários</h3>
      <div className="space-y-4">
        {records.length === 0 && <p className="text-sm text-[var(--muted-2)]">Nenhum registro ainda.</p>}
        {records.map((r) => (
          <RecordCard
            key={r.id}
            record={r}
            caregiverName={namesMap[r.caregiver_user_id] || "Cuidador"}
            editHref={`/admin/pacientes/${patient.id}/registros/${r.id}`}
            deleteEndpoint={isAdmin ? `/api/admin/patients/${patient.id}/records/${r.id}` : undefined}
            deleteConfirmText={`Excluir o registro de ${r.record_date}? Todas as alterações desse registro também serão removidas do histórico.`}
          />
        ))}
      </div>
    </div>
  );
}
