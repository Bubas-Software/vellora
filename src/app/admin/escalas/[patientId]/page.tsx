import Link from "next/link";
import { notFound } from "next/navigation";
import { ScheduleCalendar } from "@/components/schedules/ScheduleCalendar";
import { getPatient, getUserById } from "@/lib/data";
import { getSession } from "@/lib/auth";

export default async function AdminPatientSchedulePage({ params }: { params: Promise<{ patientId: string }> }) {
  const { patientId } = await params;
  const session = await getSession();
  if (!session || (session.role !== "admin" && session.role !== "coordenador_operacional")) notFound();
  const patient = await getPatient(patientId);
  if (!patient) notFound();

  const family = patient.family_user_id ? await getUserById(patient.family_user_id) : undefined;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <Link href="/admin/escalas" className="inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-[var(--brand)] hover:text-[var(--brand-dark)]">
        ← Voltar para escalas
      </Link>
      <header className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
        <p className="eyebrow">Escalas do paciente</p>
        <h2 className="mt-2 break-words text-2xl font-semibold text-[var(--foreground)]">{patient.name}</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Familiar responsável: {family?.name || "Nenhum familiar vinculado"}
        </p>
        {patient.care_level && <p className="mt-1 text-sm text-[var(--muted-2)]">Plano de cuidado: {patient.care_level}</p>}
      </header>
      <ScheduleCalendar
        key={patient.id}
        mode="admin"
        patientId={patient.id}
        patientName={patient.name}
        canManagePayroll={session.role === "admin"}
      />
    </div>
  );
}
