import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import {
  getPatient,
  getUsersByIds,
  listAssignmentsForPatient,
  listCaregiverProfiles,
} from "@/lib/data";
import { apiError } from "@/lib/api-error";
import { parseScheduleMonth } from "@/lib/schedule-validation";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const guard = await requireRole("admin", "coordenador_operacional");
  if ("error" in guard) return guard.error;

  const search = request.nextUrl.searchParams;
  const patientId = search.get("patient_id") || "";
  const range = parseScheduleMonth(search.get("month"));
  if (!UUID_PATTERN.test(patientId) || !range) {
    return NextResponse.json({ error: "Selecione um paciente e um mês válidos." }, { status: 400 });
  }

  try {
    if (!(await getPatient(patientId))) {
      return NextResponse.json({ error: "Paciente não encontrado." }, { status: 404 });
    }

    // This roster intentionally uses only existing assignments and profiles;
    // it remains available even before the new schedule table is migrated.
    const assignments = (await listAssignmentsForPatient(patientId)).filter((assignment) =>
      assignment.active === 1
      && assignment.start_date <= range.lastDay
      && (!assignment.end_date || assignment.end_date >= range.start),
    );
    const [users, profiles] = await Promise.all([
      getUsersByIds([...new Set(assignments.map((assignment) => assignment.caregiver_user_id))]),
      listCaregiverProfiles(),
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const profileByUserId = new Map(
      profiles.filter((profile) => profile.user_id).map((profile) => [profile.user_id!, profile]),
    );
    const professionals = new Map<string, {
      user_id: string;
      name: string;
      profession: string;
      phone: string | null;
      start_date: string;
      end_date: string | null;
    }>();

    for (const assignment of assignments) {
      const user = userById.get(assignment.caregiver_user_id);
      const profile = profileByUserId.get(assignment.caregiver_user_id);
      if (!user || user.role !== "cuidador" || !profile || profile.account_status !== "ativo") continue;

      const previous = professionals.get(user.id);
      if (!previous || assignment.start_date > previous.start_date) {
        professionals.set(user.id, {
          user_id: user.id,
          name: user.name,
          profession: profile.profession,
          phone: user.phone,
          start_date: assignment.start_date,
          end_date: assignment.end_date,
        });
      }
    }

    return NextResponse.json({ professionals: [...professionals.values()] });
  } catch (error) {
    return apiError(error, "api/admin/schedules/professionals", "Não foi possível listar os profissionais vinculados ao paciente.");
  }
}
