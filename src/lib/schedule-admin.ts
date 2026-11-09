import type { CaregiverScheduleEntry, CaregiverScheduleEntryInput } from "./data";
import {
  getCaregiverProfileByUserId,
  listAssignmentsForPatient,
  type Assignment,
} from "./data";
import {
  isScheduleDate,
  isScheduleTime,
  isValidScheduleTimeRange,
  scheduleIntervalsOverlap,
  shiftScheduleDate,
} from "./schedule-validation";
import { SCHEDULE_OVERLAP_CONFLICT_MESSAGE } from "./schedule-errors";
import { listCaregiverScheduleEntriesForProfessional } from "./data";
import { generateScheduleRecurrence } from "./schedule-recurrence";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ScheduleMutation = {
  patient_id: string;
  caregiver_user_id: string;
  scheduled_date: string;
  start_time: string;
  end_time: string;
  ends_next_day: boolean;
  payroll_amount_override_cents?: number | null;
};

export type RecurringScheduleMutation = {
  patient_id: string;
  caregiver_user_id: string;
  start_date: string;
  end_date: string;
  start_time: string;
  end_time: string;
  ends_next_day: boolean;
  dates: string[];
};

function parsePayrollAmountOverride(
  value: unknown,
): { value: number | null; error?: never } | { value?: never; error: string } {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return { value: null };
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return { error: "Informe um valor excepcional válido ou deixe o campo vazio para usar a tarifa da família." };
  }
  const raw = String(value).trim().replace(",", ".");
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) {
    return { error: "Informe um valor excepcional válido ou deixe o campo vazio para usar a tarifa da família." };
  }
  const amountCents = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 100_000_000) {
    return { error: "O valor excepcional deve ser maior que zero e não pode passar de R$ 1.000.000,00." };
  }
  return { value: amountCents };
}

export function parseScheduleMutation(value: unknown, allowPayrollOverride = true): { data?: ScheduleMutation; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Revise os dados da escala e tente novamente." };
  }
  const body = value as Record<string, unknown>;
  const patientId = typeof body.patient_id === "string" ? body.patient_id : "";
  const caregiverUserId = typeof body.caregiver_user_id === "string" ? body.caregiver_user_id : "";
  const scheduledDate = body.scheduled_date;
  const startTime = body.start_time;
  const endTime = body.end_time;
  const endsNextDay = body.ends_next_day;
  const rawPayrollOverride = body.payroll_amount_override;
  if (!allowPayrollOverride && rawPayrollOverride !== undefined && rawPayrollOverride !== null && String(rawPayrollOverride).trim()) {
    return { error: "Somente o Administrador pode definir o valor excepcional do plantão." };
  }
  const payrollAmountOverride = allowPayrollOverride
    ? parsePayrollAmountOverride(rawPayrollOverride)
    : { value: null };

  if (!UUID_PATTERN.test(patientId) || !UUID_PATTERN.test(caregiverUserId)) {
    return { error: "Selecione um paciente e um profissional válidos." };
  }
  if (!isScheduleDate(scheduledDate)) return { error: "Selecione uma data válida para a escala." };
  if (!isScheduleTime(startTime) || !isScheduleTime(endTime)) {
    return { error: "Informe horários válidos para o início e o fim do plantão." };
  }
  if (typeof endsNextDay !== "boolean") {
    return { error: "Informe se o plantão termina no dia seguinte." };
  }
  if (!isValidScheduleTimeRange(startTime, endTime, endsNextDay)) {
    return {
      error: endsNextDay
        ? "Para um plantão que termina no dia seguinte, o horário final deve ser igual ou anterior ao inicial."
        : "O horário final deve ser posterior ao horário inicial. Marque a opção de término no dia seguinte para plantões noturnos.",
    };
  }
  if ("error" in payrollAmountOverride) return { error: payrollAmountOverride.error };
  return {
    data: {
      patient_id: patientId,
      caregiver_user_id: caregiverUserId,
      scheduled_date: scheduledDate,
      start_time: startTime,
      end_time: endTime,
      ends_next_day: endsNextDay,
      ...(allowPayrollOverride ? { payroll_amount_override_cents: payrollAmountOverride.value ?? null } : {}),
    },
  };
}

export function parseRecurringScheduleMutation(value: unknown): { data?: RecurringScheduleMutation; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Revise os dados da recorrência e tente novamente." };
  }
  const body = value as Record<string, unknown>;
  const patientId = typeof body.patient_id === "string" ? body.patient_id : "";
  const caregiverUserId = typeof body.caregiver_user_id === "string" ? body.caregiver_user_id : "";
  const startDate = body.start_date;
  const endDate = body.end_date;
  const startTime = body.start_time;
  const endTime = body.end_time;
  const endsNextDay = body.ends_next_day;

  if (!UUID_PATTERN.test(patientId) || !UUID_PATTERN.test(caregiverUserId)) {
    return { error: "Selecione um paciente e um profissional válidos." };
  }
  if (!isScheduleDate(startDate) || !isScheduleDate(endDate)) {
    return { error: "Informe datas válidas para a recorrência." };
  }
  if (!isScheduleTime(startTime) || !isScheduleTime(endTime)) {
    return { error: "Informe horários válidos para o início e o fim do plantão." };
  }
  if (typeof endsNextDay !== "boolean") {
    return { error: "Informe se o plantão termina no dia seguinte." };
  }
  if (!isValidScheduleTimeRange(startTime, endTime, endsNextDay)) {
    return {
      error: endsNextDay
        ? "Para um plantão que termina no dia seguinte, o horário final deve ser igual ou anterior ao inicial."
        : "O horário final deve ser posterior ao horário inicial. Marque a opção de término no dia seguinte para plantões noturnos.",
    };
  }

  const recurrence = generateScheduleRecurrence({
    start_date: startDate,
    end_date: endDate,
    pattern: body.pattern,
    interval_days: body.interval_days,
    weekdays: body.weekdays,
    dates: body.dates,
    skip_dates: body.skip_dates,
  });
  if ("error" in recurrence) return { error: recurrence.error };
  return {
    data: {
      patient_id: patientId,
      caregiver_user_id: caregiverUserId,
      start_date: startDate,
      end_date: endDate,
      start_time: startTime,
      end_time: endTime,
      ends_next_day: endsNextDay,
      dates: recurrence.dates,
    },
  };
}

function assignmentCoversDate(assignment: Assignment, scheduledDate: string): boolean {
  return assignment.start_date <= scheduledDate && (!assignment.end_date || assignment.end_date >= scheduledDate);
}

export async function resolveScheduleMutation(
  mutation: ScheduleMutation,
  existing?: CaregiverScheduleEntry,
): Promise<{ data?: CaregiverScheduleEntryInput; error?: string; conflict?: boolean }> {
  const assignments = await listAssignmentsForPatient(mutation.patient_id);
  const assignment = assignments.find((candidate) =>
    candidate.caregiver_user_id === mutation.caregiver_user_id
      && assignmentCoversDate(candidate, mutation.scheduled_date)
      && (candidate.active === 1 || candidate.id === existing?.caregiver_assignment_id),
  );
  if (!assignment) {
    return { error: "Esse profissional não tem vínculo válido com o paciente na data selecionada." };
  }

  const caregiverProfile = await getCaregiverProfileByUserId(mutation.caregiver_user_id);
  const sameExistingAssignment = assignment.id === existing?.caregiver_assignment_id;
  if ((!caregiverProfile || caregiverProfile.account_status !== "ativo") && !sameExistingAssignment) {
    return { error: "Selecione um profissional com cadastro ativo e vínculo válido com o paciente." };
  }

  const conflictStart = shiftScheduleDate(mutation.scheduled_date, -1);
  const conflictEnd = shiftScheduleDate(mutation.scheduled_date, 2);
  if (!conflictStart || !conflictEnd) return { error: "Selecione uma data válida para a escala." };
  const professionalSchedules = await listCaregiverScheduleEntriesForProfessional(
    mutation.caregiver_user_id,
    conflictStart,
    conflictEnd,
  );
  const newSchedule = {
    scheduled_date: mutation.scheduled_date,
    start_time: mutation.start_time,
    end_time: mutation.end_time,
    ends_next_day: mutation.ends_next_day,
  };
  if (professionalSchedules.some((schedule) =>
    schedule.id !== existing?.id && scheduleIntervalsOverlap(newSchedule, schedule),
  )) {
    return { error: SCHEDULE_OVERLAP_CONFLICT_MESSAGE, conflict: true };
  }

  return {
    data: {
      caregiver_assignment_id: assignment.id,
      scheduled_date: mutation.scheduled_date,
      start_time: mutation.start_time,
      end_time: mutation.end_time,
      ends_next_day: mutation.ends_next_day,
      profession: caregiverProfile?.profession || existing?.profession || "cuidador",
      ...(mutation.payroll_amount_override_cents !== undefined
        ? { payroll_amount_override_cents: mutation.payroll_amount_override_cents }
        : {}),
    },
  };
}

export async function resolveRecurringScheduleMutation(
  mutation: RecurringScheduleMutation,
): Promise<{ data?: CaregiverScheduleEntryInput[]; error?: string; conflict?: boolean }> {
  const assignments = await listAssignmentsForPatient(mutation.patient_id);
  const professionalAssignments = assignments.filter((assignment) =>
    assignment.caregiver_user_id === mutation.caregiver_user_id && assignment.active === 1,
  );
  const caregiverProfile = await getCaregiverProfileByUserId(mutation.caregiver_user_id);
  if (!caregiverProfile || caregiverProfile.account_status !== "ativo") {
    return { error: "Selecione um profissional com cadastro ativo e vínculo válido com o paciente." };
  }

  const assignmentByDate = new Map<string, Assignment>();
  for (const scheduledDate of mutation.dates) {
    const assignment = professionalAssignments.find((candidate) => assignmentCoversDate(candidate, scheduledDate));
    if (!assignment) {
      const formattedDate = scheduledDate.split("-").reverse().join("/");
      return { error: `O profissional não tem vínculo ativo com o paciente em ${formattedDate}. Ajuste o período ou o padrão.` };
    }
    assignmentByDate.set(scheduledDate, assignment);
  }

  const firstConflictDate = shiftScheduleDate(mutation.dates[0], -1);
  const lastConflictDate = shiftScheduleDate(mutation.dates[mutation.dates.length - 1], 2);
  if (!firstConflictDate || !lastConflictDate) return { error: "Informe datas válidas para a recorrência." };
  const existingSchedules = await listCaregiverScheduleEntriesForProfessional(
    mutation.caregiver_user_id,
    firstConflictDate,
    lastConflictDate,
  );
  const planned: CaregiverScheduleEntryInput[] = [];
  for (const scheduledDate of mutation.dates) {
    const interval = {
      scheduled_date: scheduledDate,
      start_time: mutation.start_time,
      end_time: mutation.end_time,
      ends_next_day: mutation.ends_next_day,
    };
    if (
      existingSchedules.some((schedule) => scheduleIntervalsOverlap(interval, schedule))
      || planned.some((schedule) => scheduleIntervalsOverlap(interval, schedule))
    ) {
      return { error: SCHEDULE_OVERLAP_CONFLICT_MESSAGE, conflict: true };
    }
    planned.push({
      caregiver_assignment_id: assignmentByDate.get(scheduledDate)!.id,
      scheduled_date: scheduledDate,
      start_time: mutation.start_time,
      end_time: mutation.end_time,
      ends_next_day: mutation.ends_next_day,
      profession: caregiverProfile.profession,
    });
  }

  return { data: planned };
}
