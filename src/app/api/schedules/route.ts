import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import {
  getPatient,
  getUsersByIds,
  listAssignmentsForPatient,
  listCaregiverProfiles,
  listCaregiverScheduleEntriesForCaregiver,
  listCaregiverScheduleEntriesForPatient,
  listPatientsByCaregiver,
} from "@/lib/data";
import { apiError } from "@/lib/api-error";
import { parseScheduleMonth } from "@/lib/schedule-validation";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const guard = await requireRole("admin", "coordenador_operacional", "cuidador");
  if ("error" in guard) return guard.error;

  const search = request.nextUrl.searchParams;
  const range = parseScheduleMonth(search.get("month"));
  if (!range) {
    return NextResponse.json({ error: "Selecione um mês válido para consultar as escalas." }, { status: 400 });
  }

  try {
    if (guard.session.role === "cuidador") {
      const entries = await listCaregiverScheduleEntriesForCaregiver(
        guard.session.userId,
        range.start,
        range.endExclusive,
      );
      const patients = await listPatientsByCaregiver(guard.session.userId);
      const patientNames = new Map(patients.map((patient) => [patient.id, patient.name]));
      return NextResponse.json({
        entries: entries
          .filter((entry) => entry.caregiver_user_id === guard.session.userId)
          .map((entry) => {
            const safeEntry = { ...entry };
            delete safeEntry.payroll_rate_status;
            delete safeEntry.payroll_amount_override_cents;
            return {
              ...safeEntry,
              patient_name: patientNames.get(entry.patient_id) || "Paciente",
            };
          }),
      });
    }

    const patientId = search.get("patient_id") || "";
    if (!UUID_PATTERN.test(patientId)) {
      return NextResponse.json({ error: "Selecione um paciente válido para consultar as escalas." }, { status: 400 });
    }
    const patient = await getPatient(patientId);
    if (!patient) return NextResponse.json({ error: "Paciente não encontrado." }, { status: 404 });

    const [entries, assignments, caregiverProfiles] = await Promise.all([
      listCaregiverScheduleEntriesForPatient(patientId, range.start, range.endExclusive),
      listAssignmentsForPatient(patientId),
      listCaregiverProfiles(),
    ]);
    const allCaregiverIds = [...new Set([
      ...entries.map((entry) => entry.caregiver_user_id),
      ...assignments.map((assignment) => assignment.caregiver_user_id),
    ])];
    const users = await getUsersByIds(allCaregiverIds);
    const userById = new Map(users.map((user) => [user.id, user]));
    const profileByUserId = new Map(
      caregiverProfiles.filter((profile) => profile.user_id).map((profile) => [profile.user_id!, profile]),
    );
    const entryAssignmentIds = new Set(entries.map((entry) => entry.caregiver_assignment_id));
    const candidateByUserId = new Map<string, {
      user_id: string;
      name: string;
      profession: string;
      phone: string | null;
      start_date: string;
      end_date: string | null;
      active: boolean;
    }>();

    for (const assignment of assignments) {
      const user = userById.get(assignment.caregiver_user_id);
      const profile = profileByUserId.get(assignment.caregiver_user_id);
      const existingSchedule = entryAssignmentIds.has(assignment.id);
      const overlapsMonth = assignment.start_date <= range.lastDay
        && (!assignment.end_date || assignment.end_date >= range.start);
      if (
        !user
        || user.role !== "cuidador"
        || !profile
        || (!existingSchedule && (assignment.active !== 1 || profile.account_status !== "ativo"))
        || !overlapsMonth
      ) continue;

      const option = {
        user_id: user.id,
        name: user.name,
        profession: profile.profession,
        phone: user.phone,
        start_date: assignment.start_date,
        end_date: assignment.end_date,
        active: assignment.active === 1,
      };
      const previous = candidateByUserId.get(user.id);
      if (!previous || (option.active && !previous.active) || option.start_date > previous.start_date) {
        candidateByUserId.set(user.id, option);
      }
    }

    return NextResponse.json({
      entries: entries.map((entry) => {
        const user = userById.get(entry.caregiver_user_id);
        const safeEntry = { ...entry };
        if (guard.session.role === "coordenador_operacional") {
          delete safeEntry.payroll_rate_status;
          delete safeEntry.payroll_amount_override_cents;
        }
        return {
          ...safeEntry,
          professional_name: user?.name || "Profissional",
          professional_phone: user?.phone || null,
        };
      }),
      professionals: [...candidateByUserId.values()].map((professional) => ({
        user_id: professional.user_id,
        name: professional.name,
        profession: professional.profession,
        phone: professional.phone,
        start_date: professional.start_date,
        end_date: professional.end_date,
      })),
    });
  } catch (error) {
    return apiError(error, "api/schedules", "Não foi possível carregar as escalas. Confirme se a migration de escalas já foi aplicada ao banco.");
  }
}
