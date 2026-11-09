import { executeBatch, query, queryOne } from "./db";
import { randomUUID } from "crypto";
import { hashPassword } from "./auth";
import {
  deleteStoredFile,
  deleteStoredFiles,
  getStoredFile,
  putStoredFile,
} from "./storage";
import { diffDailyRecord, snapshotDailyRecord } from "./record-utils";
import * as supabaseData from "./supabase/data";
import { resolveAuthProvider } from "./auth-provider";
import { runtimeValue } from "./runtime-config";
import {
  ASSIGNMENT_ACTIVE_CONFLICT_MESSAGE,
  ASSIGNMENT_DUPLICATE_CONFLICT_MESSAGE,
  ASSIGNMENT_HISTORY_CONFLICT_MESSAGE,
  AssignmentConflictError,
  isAssignmentUniqueViolation,
} from "./assignment-errors";
import { ScheduleHistoryConflictError } from "./schedule-errors";
import { FinanceConflictError, FinanceNotFoundError } from "./finance-errors";
import { buildFinanceCashFlow, financeChartRange, shiftFinanceMonth } from "./finance-utils";

export type User = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: "admin" | "coordenador_operacional" | "familia" | "cuidador";
  phone: string | null;
  session_version: number;
  deleted_at: string | null;
  created_at: string;
};

export type Patient = {
  id: string;
  name: string;
  birth_date: string | null;
  address: string | null;
  care_level: string | null;
  condition_summary: string | null;
  family_user_id: string | null;
  status: "pendente" | "ativo" | "inativo";
  notes: string | null;
  created_at: string;
};

export type Assignment = {
  id: string;
  patient_id: string;
  caregiver_user_id: string;
  start_date: string;
  end_date: string | null;
  active: number;
  created_at: string;
};

export type PayrollRateStatus = "valor_pendente" | "gerado";

export type FamilyPatientServiceRate = {
  id: string;
  family_user_id: string;
  patient_id: string;
  profession: ProfessionalApplication["profession"];
  amount_cents: number;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
};

export type FamilyPatientServiceRateInput = {
  family_user_id: string;
  patient_id: string;
  effective_from: string;
  rates: Array<{
    profession: ProfessionalApplication["profession"];
    amount_cents: number;
  }>;
};

export type FamilyContractedService = Pick<FamilyPatientServiceRate, "patient_id" | "profession">;

export type CaregiverScheduleEntry = {
  id: string;
  caregiver_assignment_id: string;
  patient_id: string;
  caregiver_user_id: string;
  scheduled_date: string;
  start_time: string;
  end_time: string;
  ends_next_day: boolean;
  profession: ProfessionalApplication["profession"];
  payroll_amount_override_cents?: number | null;
  payroll_rate_status?: PayrollRateStatus;
  created_at: string;
  updated_at: string;
};

export type CaregiverScheduleEntryInput = {
  caregiver_assignment_id: string;
  scheduled_date: string;
  start_time: string;
  end_time: string;
  ends_next_day: boolean;
  profession: ProfessionalApplication["profession"];
  payroll_amount_override_cents?: number | null;
};

export type Lead = {
  id: string;
  name: string;
  email: string;
  phone: string;
  patient_name: string | null;
  care_type: string | null;
  message: string | null;
  status: "novo" | "em_contato" | "convertido" | "recusado";
  created_at: string;
};

export type ProfessionalApplication = {
  id: string;
  name: string;
  email: string;
  phone: string;
  city: string | null;
  profession: "cuidador" | "tecnico_enfermagem" | "enfermeiro" | "outros";
  coren: string | null;
  experience: string | null;
  availability_days: string[];
  availability_shifts: string[];
  available_from: string | null;
  notes: string | null;
  status: "novo" | "em_analise" | "aprovado" | "recusado";
  lgpd_consent: boolean;
  lgpd_consent_at: string | null;
  privacy_notice_version: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
};

export type CaregiverProfile = {
  id: string;
  application_id: string | null;
  user_id: string | null;
  name: string;
  contact_email: string;
  access_email: string | null;
  phone: string;
  city: string | null;
  profession: ProfessionalApplication["profession"];
  coren: string | null;
  experience: string | null;
  availability_days: string[];
  availability_shifts: string[];
  available_from: string | null;
  notes: string | null;
  account_status: "aguardando_acesso" | "ativo" | "inativo";
  approved_at: string;
  created_at: string;
};

const PORTAL_PATIENT_COLUMNS =
  "id, name, birth_date, address, care_level, condition_summary, family_user_id, status, created_at";

export type CaregiverProfileUpdate = {
  name?: string;
  contact_email?: string;
  phone?: string;
  city?: string | null;
  profession?: CaregiverProfile["profession"];
  coren?: string | null;
  experience?: string | null;
  availability_days?: string[];
  availability_shifts?: string[];
  available_from?: string | null;
  notes?: string | null;
};

export type CaregiverUserUpdate = {
  name?: string;
  phone?: string | null;
  profession?: CaregiverProfile["profession"];
  availability_days?: string[];
  availability_shifts?: string[];
  available_from?: string | null;
};

export type CaregiverUserUpdateResult = {
  profileId: string;
};

export type FamilyUserUpdate = {
  name?: string;
  phone?: string | null;
};

export type ContractDocument = {
  id: string;
  family_user_id: string | null;
  caregiver_profile_id: string | null;
  caregiver_user_id: string | null;
  file_name: string;
  mime_type: string;
  file_size: number;
  uploaded_by: string | null;
  created_at: string;
};

export type StoredContractDocumentInput = {
  id: string;
  ownerType: ContractOwnerType;
  ownerId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storageKey: string;
  uploadedBy: string;
};

type StoredContractDocument = ContractDocument & { storage_key: string };

export type DailyRecord = {
  id: string;
  patient_id: string;
  caregiver_user_id: string;
  record_date: string;
  record_time: string | null;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  heart_rate: number | null;
  temperature: number | null;
  spo2: number | null;
  glucose: number | null;
  medications: string | null;
  feeding: string | null;
  hygiene: string | null;
  mobility: string | null;
  mood: string | null;
  pain_level: number | null;
  notes: string | null;
  incident: number;
  incident_description: string | null;
  photo_data: string | null;
  created_at: string;
  updated_at: string;
};

export type DailyRecordAuditEvent = {
  id: string;
  record_id: string;
  patient_id: string;
  actor_user_id: string | null;
  actor_name: string;
  action: "created" | "updated";
  changed_fields: string[];
  before_data: string | null;
  after_data: string | null;
  created_at: string;
};

export type RecordAuditActor = {
  userId: string;
  name: string;
};

export type FinanceExpenseCategory =
  | "marketing"
  | "sistema"
  | "contabilidade"
  | "impostos"
  | "equipe"
  | "operacao"
  | "outros";

export type FinanceCharge = {
  id: string;
  label: string;
  competence_month: string;
  due_date: string;
  amount_cents: number;
  received_cents: number;
  created_at: string;
  updated_at: string;
};

export type FinanceExpense = {
  id: string;
  expense_date: string;
  category: FinanceExpenseCategory;
  description: string;
  amount_cents: number;
  paid_on: string | null;
  caregiver_schedule_entry_id: string | null;
  patient_name: string | null;
  caregiver_user_id: string | null;
  payee: string | null;
  caregiver_payroll_amount_overridden: boolean;
  created_at: string;
  updated_at: string;
};

export type FinanceReceiptMovement = {
  received_on: string;
  amount_cents: number;
};

export type FinanceExpensePaymentMovement = {
  paid_on: string;
  amount_cents: number;
};

export type FinanceCashFlowPoint = {
  month: string;
  received_cents: number;
  paid_cents: number;
};

export type FinanceDashboardSnapshot = {
  month: string;
  charges: FinanceCharge[];
  expenses: FinanceExpense[];
  cash_flow: FinanceCashFlowPoint[];
};

export type FinanceChargeInput = {
  label: string;
  competence_month: string;
  due_date: string;
  amount_cents: number;
};

export type FinanceReceiptInput = {
  received_on: string;
  amount_cents: number;
};

export type FinanceExpenseInput = {
  expense_date: string;
  category: FinanceExpenseCategory;
  description: string;
  amount_cents: number;
  paid_on: string | null;
};

export type FinancePayrollExpenseUpdate = {
  amount_cents: number;
  paid_on: string | null;
};

// ---------- Users ----------
function shouldUseSupabaseData(): boolean {
  const provider = supabaseData.getDataProvider();
  if (
    resolveAuthProvider(runtimeValue("VELLORA_AUTH_PROVIDER")) === "supabase" &&
    provider !== "supabase"
  ) {
    throw new supabaseData.SupabaseDataError(
      "VELLORA_AUTH_PROVIDER=supabase exige VELLORA_DATA_PROVIDER=supabase para evitar misturar dados D1 e Supabase.",
    );
  }
  return provider === "supabase";
}

function brazilToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function familyPatientRateMonthStart(date: string): string {
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new Error("Informe uma competência válida para a tarifa.");
  }
  const monthStart = `${date.slice(0, 7)}-01`;
  const currentMonthStart = `${brazilToday().slice(0, 7)}-01`;
  if (monthStart < currentMonthStart) {
    throw new Error("Não é possível alterar tarifas de competências passadas.");
  }
  return monthStart;
}

export async function getUserByEmail(email: string): Promise<User | undefined> {
  if (shouldUseSupabaseData()) return supabaseData.getUserByEmail(email);
  return queryOne<User>("SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL", [email]);
}

export async function getUserById(id: string): Promise<User | undefined> {
  if (shouldUseSupabaseData()) return supabaseData.getUserById(id);
  return queryOne<User>("SELECT * FROM users WHERE id = $1", [id]);
}

export async function getUsersByIds(ids: string[]): Promise<User[]> {
  if (shouldUseSupabaseData()) return supabaseData.getUsersByIds(ids);
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(",");
  return query<User>(`SELECT * FROM users WHERE id IN (${placeholders})`, ids);
}

export async function listUsersByRole(role: string, includeInactive = false): Promise<User[]> {
  if (shouldUseSupabaseData()) return supabaseData.listUsersByRole(role, includeInactive);
  return query<User>(
    `SELECT * FROM users WHERE role = $1 ${includeInactive ? "" : "AND deleted_at IS NULL"} ORDER BY name`,
    [role],
  );
}

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
  role: "admin" | "coordenador_operacional" | "familia" | "cuidador";
  phone?: string;
}): Promise<User> {
  if (shouldUseSupabaseData()) return supabaseData.createUser(input);
  const id = randomUUID();
  await query(
    "INSERT INTO users (id, name, email, password_hash, role, phone) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, input.name, input.email.toLowerCase().trim(), hashPassword(input.password), input.role, input.phone || null]
  );
  return (await getUserById(id))!;
}

export async function setCoordinatorAccountActive(id: string, active: boolean): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.setCoordinatorAccountActive(id, active);
  await query(
    `UPDATE users
     SET deleted_at = ${active ? "NULL" : "CURRENT_TIMESTAMP"},
         session_version = session_version + 1
     WHERE id = $1 AND role = 'coordenador_operacional'`,
    [id],
  );
}

export async function createManualCaregiver(input: {
  name: string;
  email: string;
  password: string;
  phone?: string;
  profession: CaregiverProfile["profession"];
}): Promise<User> {
  if (shouldUseSupabaseData()) return supabaseData.createManualCaregiver(input);

  const userId = randomUUID();
  const profileId = randomUUID();
  const normalizedEmail = input.email.toLowerCase().trim();
  await executeBatch([
    {
      text: "INSERT INTO users (id, name, email, password_hash, role, phone) VALUES ($1,$2,$3,$4,'cuidador',$5)",
      params: [userId, input.name, normalizedEmail, hashPassword(input.password), input.phone || null],
    },
    {
      text: `INSERT INTO caregiver_profiles
        (id, application_id, user_id, name, contact_email, phone, profession,
         availability_days, availability_shifts, account_status, approved_at)
       VALUES ($1,NULL,$2,$3,$4,$5,$6,'[]','[]','ativo',CURRENT_TIMESTAMP)`,
      params: [profileId, userId, input.name, normalizedEmail, input.phone || "", input.profession],
    },
  ]);
  return (await getUserById(userId))!;
}

export async function updateFamilyUser(id: string, fields: FamilyUserUpdate): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.updateFamilyUser(id, fields);
  const allowed: (keyof FamilyUserUpdate)[] = ["name", "phone"];
  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = $${index}`);
      values.push(fields[key] ?? null);
      index += 1;
    }
  }
  if (!sets.length) return;
  values.push(id);
  await query(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${index} AND role = 'familia' AND deleted_at IS NULL`,
    values,
  );
}

// ---------- Patients ----------
export async function getActivePatientCount(): Promise<number> {
  if (shouldUseSupabaseData()) return supabaseData.getActivePatientCount();
  const result = await queryOne<{ active_count: number | string }>(
    "SELECT COUNT(*) AS active_count FROM patients WHERE status = 'ativo'",
  );
  return Number(result?.active_count || 0);
}

export async function listPatients(): Promise<Patient[]> {
  if (shouldUseSupabaseData()) return supabaseData.listPatients();
  return query<Patient>("SELECT * FROM patients ORDER BY created_at DESC");
}

export async function getPatient(id: string): Promise<Patient | undefined> {
  if (shouldUseSupabaseData()) return supabaseData.getPatient(id);
  return queryOne<Patient>("SELECT * FROM patients WHERE id = $1", [id]);
}

export async function getPatientForPortal(id: string): Promise<Patient | undefined> {
  if (shouldUseSupabaseData()) return supabaseData.getPatientForPortal(id);
  return queryOne<Patient>(
    `SELECT ${PORTAL_PATIENT_COLUMNS}
     FROM patients WHERE id = $1`,
    [id],
  );
}

export async function listPatientsByFamily(familyUserId: string): Promise<Patient[]> {
  if (shouldUseSupabaseData()) return supabaseData.listPatientsByFamily(familyUserId);
  return query<Patient>(
    `SELECT ${PORTAL_PATIENT_COLUMNS}
     FROM patients WHERE family_user_id = $1 ORDER BY created_at DESC`,
    [familyUserId],
  );
}

export async function listFamilyPatientServiceRates(familyUserId: string): Promise<FamilyPatientServiceRate[]> {
  if (shouldUseSupabaseData()) return supabaseData.listFamilyPatientServiceRates(familyUserId);
  return query<FamilyPatientServiceRate>(
    `SELECT id, family_user_id, patient_id, profession, amount_cents, valid_from, valid_to, created_at, updated_at
     FROM family_patient_service_rates
     WHERE family_user_id = $1
     ORDER BY patient_id, profession, valid_from DESC`,
    [familyUserId],
  );
}

export async function listFamilyContractedServices(familyUserId: string): Promise<FamilyContractedService[]> {
  if (shouldUseSupabaseData()) return supabaseData.listFamilyContractedServices(familyUserId);
  const today = brazilToday();
  return query<FamilyContractedService>(
    `SELECT DISTINCT patient_id, profession
     FROM family_patient_service_rates
     WHERE family_user_id = $1 AND valid_from <= $2
       AND (valid_to IS NULL OR valid_to >= $2)
     ORDER BY patient_id, profession`,
    [familyUserId, today],
  );
}

export async function saveFamilyPatientServiceRates(input: FamilyPatientServiceRateInput): Promise<void> {
  const effectiveFrom = familyPatientRateMonthStart(input.effective_from);
  const normalizedInput = { ...input, effective_from: effectiveFrom };
  if (shouldUseSupabaseData()) return supabaseData.saveFamilyPatientServiceRates(normalizedInput);

  const patient = await getPatient(normalizedInput.patient_id);
  if (!patient || patient.family_user_id !== normalizedInput.family_user_id) {
    throw new Error("O paciente não pertence à família informada.");
  }

  const supportedProfessions: ProfessionalApplication["profession"][] = [
    "cuidador",
    "tecnico_enfermagem",
    "enfermeiro",
    "outros",
  ];
  const selectedRates = new Map(normalizedInput.rates.map((rate) => [rate.profession, rate.amount_cents] as const));
  if (
    selectedRates.size !== normalizedInput.rates.length ||
    normalizedInput.rates.some((rate) => !supportedProfessions.includes(rate.profession)
      || !Number.isSafeInteger(rate.amount_cents)
      || rate.amount_cents <= 0
      || rate.amount_cents > 100_000_000)
  ) {
    throw new Error("Informe valores válidos e únicos para os serviços contratados.");
  }

  const commands: Array<{ text: string; params: unknown[] }> = [];
  for (const profession of supportedProfessions) {
    commands.push({
      text: `DELETE FROM family_patient_service_rates
             WHERE family_user_id = $1 AND patient_id = $2 AND profession = $3 AND valid_from >= $4`,
      params: [normalizedInput.family_user_id, normalizedInput.patient_id, profession, effectiveFrom],
    });
    commands.push({
      text: `UPDATE family_patient_service_rates
             SET valid_to = date($1, '-1 day'), updated_at = CURRENT_TIMESTAMP
             WHERE family_user_id = $2 AND patient_id = $3 AND profession = $4
               AND valid_from < $1 AND (valid_to IS NULL OR valid_to >= $1)`,
      params: [effectiveFrom, normalizedInput.family_user_id, normalizedInput.patient_id, profession],
    });
    const amountCents = selectedRates.get(profession);
    if (amountCents !== undefined) {
      commands.push({
        text: `INSERT INTO family_patient_service_rates
                 (id, family_user_id, patient_id, profession, amount_cents, valid_from)
               VALUES ($1, $2, $3, $4, $5, $6)`,
        params: [randomUUID(), normalizedInput.family_user_id, normalizedInput.patient_id, profession, amountCents, effectiveFrom],
      });
    }
  }
  await executeBatch(commands);
  await syncLegacyCaregiverPayrollForPatient(normalizedInput.patient_id, effectiveFrom);
}

export async function listPatientsByCaregiver(caregiverUserId: string): Promise<Patient[]> {
  if (shouldUseSupabaseData()) return supabaseData.listPatientsByCaregiver(caregiverUserId);
  return query<Patient>(
    `SELECT p.${PORTAL_PATIENT_COLUMNS.replaceAll(", ", ", p.")} FROM patients p
     JOIN caregiver_assignments a ON a.patient_id = p.id
     WHERE a.caregiver_user_id = $1 AND a.active = 1
     ORDER BY p.name`,
    [caregiverUserId]
  );
}

export async function createPatient(input: {
  name: string;
  birth_date?: string;
  address?: string;
  care_level?: string;
  condition_summary?: string;
  family_user_id?: string | null;
  status?: "pendente" | "ativo" | "inativo";
  notes?: string;
}): Promise<Patient> {
  if (shouldUseSupabaseData()) return supabaseData.createPatient(input);
  const id = randomUUID();
  await query(
    `INSERT INTO patients (id, name, birth_date, address, care_level, condition_summary, family_user_id, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      input.name,
      input.birth_date || null,
      input.address || null,
      input.care_level || null,
      input.condition_summary || null,
      input.family_user_id || null,
      input.status || "pendente",
      input.notes || null,
    ]
  );
  return (await getPatient(id))!;
}

export async function updatePatient(id: string, fields: Partial<Patient>): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.updatePatient(id, fields);
  const allowed: (keyof Patient)[] = [
    "name",
    "birth_date",
    "address",
    "care_level",
    "condition_summary",
    "family_user_id",
    "status",
    "notes",
  ];
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = $${i}`);
      values.push(fields[key]);
      i++;
    }
  }
  if (sets.length === 0) return;
  values.push(id);
  await query(`UPDATE patients SET ${sets.join(", ")} WHERE id = $${i}`, values);
  if ("family_user_id" in fields) await syncLegacyCaregiverPayrollForPatient(id, brazilToday());
}

export async function deletePatient(id: string): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.deletePatient(id);
  const scheduledEntry = await queryOne<{ id: string }>(
    `SELECT s.id
     FROM caregiver_schedule_entries s
     JOIN caregiver_assignments a ON a.id = s.caregiver_assignment_id
     WHERE a.patient_id = $1
     LIMIT 1`,
    [id],
  );
  if (scheduledEntry) throw new ScheduleHistoryConflictError();
  await query("DELETE FROM patients WHERE id = $1", [id]);
}

// ---------- Assignments ----------
export async function listAssignmentsForPatient(patientId: string): Promise<Assignment[]> {
  if (shouldUseSupabaseData()) return supabaseData.listAssignmentsForPatient(patientId);
  return query<Assignment>(
    "SELECT * FROM caregiver_assignments WHERE patient_id = $1 ORDER BY active DESC, start_date DESC",
    [patientId]
  );
}

export async function createAssignment(input: { patient_id: string; caregiver_user_id: string; start_date: string }): Promise<Assignment> {
  if (shouldUseSupabaseData()) return supabaseData.createAssignment(input);

  const inactiveAssignments = await query<Assignment>(
    `SELECT * FROM caregiver_assignments
     WHERE patient_id = $1 AND caregiver_user_id = $2 AND start_date = $3 AND active = 0
     ORDER BY created_at DESC, id DESC
     LIMIT 2`,
    [input.patient_id, input.caregiver_user_id, input.start_date]
  );
  if (inactiveAssignments.length > 1) {
    throw new AssignmentConflictError("duplicate_history", ASSIGNMENT_HISTORY_CONFLICT_MESSAGE);
  }

  const activeAssignment = await queryOne<Assignment>(
    `SELECT * FROM caregiver_assignments
     WHERE patient_id = $1 AND caregiver_user_id = $2 AND active = 1
     ORDER BY start_date DESC, created_at DESC
     LIMIT 1`,
    [input.patient_id, input.caregiver_user_id]
  );
  if (activeAssignment) {
    throw new AssignmentConflictError("active_duplicate", ASSIGNMENT_ACTIVE_CONFLICT_MESSAGE);
  }

  const inactiveAssignment = inactiveAssignments[0];
  if (inactiveAssignment) {
    const restored = await query<Assignment>(
      `UPDATE caregiver_assignments
       SET active = 1, end_date = NULL
       WHERE id = $1 AND active = 0
       RETURNING *`,
      [inactiveAssignment.id]
    );
    if (restored[0]) return restored[0];

    const activeAfterRace = await queryOne<Assignment>(
      `SELECT * FROM caregiver_assignments
       WHERE patient_id = $1 AND caregiver_user_id = $2 AND active = 1
       LIMIT 1`,
      [input.patient_id, input.caregiver_user_id]
    );
    if (activeAfterRace) {
      throw new AssignmentConflictError("active_duplicate", ASSIGNMENT_ACTIVE_CONFLICT_MESSAGE);
    }
    throw new Error("Não foi possível reativar o vínculo.");
  }

  const id = randomUUID();
  try {
    await query(
      `INSERT INTO caregiver_assignments (id, patient_id, caregiver_user_id, start_date, active) VALUES ($1,$2,$3,$4,1)`,
      [id, input.patient_id, input.caregiver_user_id, input.start_date]
    );
  } catch (error) {
    if (isAssignmentUniqueViolation(error)) {
      throw new AssignmentConflictError("duplicate_assignment", ASSIGNMENT_DUPLICATE_CONFLICT_MESSAGE);
    }
    throw error;
  }

  const created = await queryOne<Assignment>("SELECT * FROM caregiver_assignments WHERE id = $1", [id]);
  if (!created) throw new Error("Não foi possível confirmar o vínculo criado.");
  return created;
}

export async function deactivateAssignment(id: string): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.deactivateAssignment(id);
  await query(
    "UPDATE caregiver_assignments SET active = 0, end_date = strftime('%Y-%m-%d','now') WHERE id = $1",
    [id]
  );
}

export async function isCaregiverAssignedToPatient(caregiverUserId: string, patientId: string): Promise<boolean> {
  if (shouldUseSupabaseData()) return supabaseData.isCaregiverAssignedToPatient(caregiverUserId, patientId);
  const row = await queryOne(
    "SELECT 1 FROM caregiver_assignments WHERE caregiver_user_id = $1 AND patient_id = $2 AND active = 1",
    [caregiverUserId, patientId]
  );
  return !!row;
}

// ---------- Caregiver schedules ----------
export async function listCaregiverScheduleEntriesForPatient(
  patientId: string,
  startDate: string,
  endDateExclusive: string,
): Promise<CaregiverScheduleEntry[]> {
  if (shouldUseSupabaseData()) {
    return supabaseData.listCaregiverScheduleEntriesForPatient(patientId, startDate, endDateExclusive);
  }
  return query<CaregiverScheduleEntry>(
    `SELECT s.id, s.caregiver_assignment_id, a.patient_id, a.caregiver_user_id,
            s.scheduled_date, s.start_time, s.end_time, s.ends_next_day,
            s.profession, s.payroll_amount_override_cents, s.payroll_rate_status, s.created_at, s.updated_at
     FROM caregiver_schedule_entries s
     JOIN caregiver_assignments a ON a.id = s.caregiver_assignment_id
     WHERE a.patient_id = $1 AND s.scheduled_date >= $2 AND s.scheduled_date < $3
     ORDER BY s.scheduled_date, s.start_time, s.id`,
    [patientId, startDate, endDateExclusive],
  );
}

export async function listCaregiverScheduleEntriesForCaregiver(
  caregiverUserId: string,
  startDate: string,
  endDateExclusive: string,
): Promise<CaregiverScheduleEntry[]> {
  if (shouldUseSupabaseData()) {
    return supabaseData.listCaregiverScheduleEntriesForCaregiver(caregiverUserId, startDate, endDateExclusive);
  }
  return query<CaregiverScheduleEntry>(
    `SELECT s.id, s.caregiver_assignment_id, a.patient_id, a.caregiver_user_id,
            s.scheduled_date, s.start_time, s.end_time, s.ends_next_day,
            s.profession, s.payroll_amount_override_cents, s.payroll_rate_status, s.created_at, s.updated_at
     FROM caregiver_schedule_entries s
     JOIN caregiver_assignments a ON a.id = s.caregiver_assignment_id
     WHERE a.caregiver_user_id = $1 AND a.active = 1
       AND s.scheduled_date >= $2 AND s.scheduled_date < $3
     ORDER BY s.scheduled_date, s.start_time, s.id`,
    [caregiverUserId, startDate, endDateExclusive],
  );
}

export async function listCaregiverScheduleEntriesForProfessional(
  caregiverUserId: string,
  startDate: string,
  endDateExclusive: string,
): Promise<CaregiverScheduleEntry[]> {
  if (shouldUseSupabaseData()) {
    return supabaseData.listCaregiverScheduleEntriesForProfessional(caregiverUserId, startDate, endDateExclusive);
  }
  return query<CaregiverScheduleEntry>(
    `SELECT s.id, s.caregiver_assignment_id, a.patient_id, a.caregiver_user_id,
            s.scheduled_date, s.start_time, s.end_time, s.ends_next_day,
            s.profession, s.payroll_amount_override_cents, s.payroll_rate_status, s.created_at, s.updated_at
     FROM caregiver_schedule_entries s
     JOIN caregiver_assignments a ON a.id = s.caregiver_assignment_id
     WHERE a.caregiver_user_id = $1
       AND s.scheduled_date >= $2 AND s.scheduled_date < $3
     ORDER BY s.scheduled_date, s.start_time, s.id`,
    [caregiverUserId, startDate, endDateExclusive],
  );
}

export async function getCaregiverScheduleEntry(id: string): Promise<CaregiverScheduleEntry | undefined> {
  if (shouldUseSupabaseData()) return supabaseData.getCaregiverScheduleEntry(id);
  return queryOne<CaregiverScheduleEntry>(
    `SELECT s.id, s.caregiver_assignment_id, a.patient_id, a.caregiver_user_id,
            s.scheduled_date, s.start_time, s.end_time, s.ends_next_day,
            s.profession, s.payroll_amount_override_cents, s.payroll_rate_status, s.created_at, s.updated_at
     FROM caregiver_schedule_entries s
     JOIN caregiver_assignments a ON a.id = s.caregiver_assignment_id
     WHERE s.id = $1`,
    [id],
  );
}

export async function createCaregiverScheduleEntry(
  input: CaregiverScheduleEntryInput,
  actorUserId: string,
): Promise<CaregiverScheduleEntry> {
  if (shouldUseSupabaseData()) return supabaseData.createCaregiverScheduleEntry(input, actorUserId);
  const id = randomUUID();
  if (input.payroll_amount_override_cents !== undefined) {
    await query(
      `INSERT INTO caregiver_schedule_entries
         (id, caregiver_assignment_id, scheduled_date, start_time, end_time,
          ends_next_day, profession, payroll_amount_override_cents, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [id, input.caregiver_assignment_id, input.scheduled_date, input.start_time, input.end_time,
        input.ends_next_day, input.profession, input.payroll_amount_override_cents, actorUserId],
    );
  } else {
    await query(
      `INSERT INTO caregiver_schedule_entries
         (id, caregiver_assignment_id, scheduled_date, start_time, end_time,
          ends_next_day, profession, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [id, input.caregiver_assignment_id, input.scheduled_date, input.start_time, input.end_time,
        input.ends_next_day, input.profession, actorUserId],
    );
  }
  const created = await getCaregiverScheduleEntry(id);
  if (!created) throw new Error("Não foi possível confirmar a escala criada.");
  await syncLegacyCaregiverPayroll([id]);
  const synced = await getCaregiverScheduleEntry(id);
  if (synced) return synced;
  return created;
}

export async function createCaregiverScheduleEntries(
  inputs: CaregiverScheduleEntryInput[],
  actorUserId: string,
): Promise<number> {
  if (inputs.length === 0 || inputs.length > 366) {
    throw new Error("A recorrência deve conter entre 1 e 366 plantões.");
  }
  if (shouldUseSupabaseData()) return supabaseData.createCaregiverScheduleEntries(inputs, actorUserId);

  const scheduleIds = inputs.map(() => randomUUID());
  await executeBatch(inputs.map((input, index) => ({
    text: `INSERT INTO caregiver_schedule_entries
       (id, caregiver_assignment_id, scheduled_date, start_time, end_time,
        ends_next_day, profession, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
    params: [
      scheduleIds[index],
      input.caregiver_assignment_id,
      input.scheduled_date,
      input.start_time,
      input.end_time,
      input.ends_next_day,
      input.profession,
      actorUserId,
    ],
  })));
  await syncLegacyCaregiverPayroll(scheduleIds);
  return inputs.length;
}

export async function updateCaregiverScheduleEntry(
  id: string,
  input: CaregiverScheduleEntryInput,
  actorUserId: string,
): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.updateCaregiverScheduleEntry(id, input, actorUserId);
  if (input.payroll_amount_override_cents !== undefined) {
    await query(
      `UPDATE caregiver_schedule_entries
       SET caregiver_assignment_id = $1, scheduled_date = $2, start_time = $3,
           end_time = $4, ends_next_day = $5, profession = $6,
           payroll_amount_override_cents = $7,
           updated_by = $8, updated_at = CURRENT_TIMESTAMP
       WHERE id = $9`,
      [input.caregiver_assignment_id, input.scheduled_date, input.start_time, input.end_time,
        input.ends_next_day, input.profession, input.payroll_amount_override_cents, actorUserId, id],
    );
  } else {
    await query(
      `UPDATE caregiver_schedule_entries
       SET caregiver_assignment_id = $1, scheduled_date = $2, start_time = $3,
           end_time = $4, ends_next_day = $5, profession = $6,
           updated_by = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8`,
      [input.caregiver_assignment_id, input.scheduled_date, input.start_time, input.end_time,
        input.ends_next_day, input.profession, actorUserId, id],
    );
  }
  await syncLegacyCaregiverPayroll([id]);
}

export async function deleteCaregiverScheduleEntry(id: string): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.deleteCaregiverScheduleEntry(id);
  await query(
    `DELETE FROM finance_expenses
     WHERE caregiver_schedule_entry_id = $1 AND paid_on IS NULL
       AND caregiver_payroll_amount_overridden = 0`,
    [id],
  );
  await query("DELETE FROM caregiver_schedule_entries WHERE id = $1", [id]);
}

async function syncLegacyCaregiverPayroll(scheduleIds: string[]): Promise<void> {
  if (!scheduleIds.length) return;
  if (scheduleIds.length > 80) {
    for (let index = 0; index < scheduleIds.length; index += 80) {
      await syncLegacyCaregiverPayroll(scheduleIds.slice(index, index + 80));
    }
    return;
  }
  const placeholders = scheduleIds.map((_, index) => `$${index + 1}`).join(", ");
  const rows = await query<{
    id: string;
    scheduled_date: string;
    profession: ProfessionalApplication["profession"];
    caregiver_user_id: string;
    caregiver_name: string | null;
    patient_name: string | null;
    created_by: string | null;
    amount_cents: number | null;
  }>(
    `SELECT entry.id, entry.scheduled_date, entry.profession,
            assignment.caregiver_user_id, caregiver.name AS caregiver_name,
            patient.name AS patient_name, entry.created_by,
            coalesce(entry.payroll_amount_override_cents, (SELECT rate.amount_cents
             FROM family_patient_service_rates AS rate
             JOIN patients AS patient ON patient.id = rate.patient_id
             WHERE rate.patient_id = assignment.patient_id
               AND rate.family_user_id = patient.family_user_id
               AND rate.profession = entry.profession
               AND entry.scheduled_date >= rate.valid_from
               AND (rate.valid_to IS NULL OR entry.scheduled_date <= rate.valid_to)
             ORDER BY rate.valid_from DESC LIMIT 1)) AS amount_cents
     FROM caregiver_schedule_entries AS entry
     JOIN caregiver_assignments AS assignment ON assignment.id = entry.caregiver_assignment_id
     JOIN patients AS patient ON patient.id = assignment.patient_id
     LEFT JOIN caregiver_profiles AS caregiver ON caregiver.user_id = assignment.caregiver_user_id
     WHERE entry.id IN (${placeholders})`,
    scheduleIds,
  );

  const commands: Array<{ text: string; params: unknown[] }> = [];
  const currentDate = brazilToday();
  async function flushCommands() {
    if (!commands.length) return;
    await executeBatch(commands.splice(0));
  }
  for (const entry of rows) {
    const amountCents = Number.isSafeInteger(entry.amount_cents) && (entry.amount_cents || 0) > 0
      ? entry.amount_cents
      : null;
    const caregiverName = entry.caregiver_name || "Profissional";
    const description = `Plantão — ${caregiverName} · ${entry.patient_name || "Paciente"}`;
    if (amountCents) {
      commands.push({
        text: "UPDATE caregiver_schedule_entries SET payroll_rate_status = 'gerado' WHERE id = $1",
        params: [entry.id],
      });
      commands.push({
        text: `INSERT INTO finance_expenses (
                 id, expense_date, category, description, amount_cents, paid_on,
                 caregiver_schedule_entry_id, caregiver_user_id, payee, created_by
               ) VALUES ($1,$2,'equipe',$3,$4,NULL,$5,$6,$8,$7)
               ON CONFLICT(caregiver_schedule_entry_id) DO UPDATE SET
                 expense_date = excluded.expense_date,
                 description = excluded.description,
                 amount_cents = CASE
                   WHEN finance_expenses.caregiver_payroll_amount_overridden THEN finance_expenses.amount_cents
                   ELSE excluded.amount_cents
                 END,
                 caregiver_user_id = excluded.caregiver_user_id,
                 payee = excluded.payee,
                 updated_at = CURRENT_TIMESTAMP
               WHERE finance_expenses.paid_on IS NULL`,
        params: [randomUUID(), entry.scheduled_date, description, amountCents,
          entry.id, entry.caregiver_user_id, entry.created_by, caregiverName],
      });
    } else if (entry.scheduled_date >= currentDate) {
      commands.push({
        text: `DELETE FROM finance_expenses
               WHERE caregiver_schedule_entry_id = $1 AND paid_on IS NULL
                 AND caregiver_payroll_amount_overridden = 0`,
        params: [entry.id],
      });
      commands.push({
        text: `UPDATE caregiver_schedule_entries
               SET payroll_rate_status = CASE WHEN EXISTS (
                 SELECT 1 FROM finance_expenses WHERE caregiver_schedule_entry_id = $1
               ) THEN 'gerado' ELSE 'valor_pendente' END
               WHERE id = $1`,
        params: [entry.id],
      });
    } else {
      commands.push({
        text: `UPDATE caregiver_schedule_entries
               SET payroll_rate_status = CASE WHEN EXISTS (
                 SELECT 1 FROM finance_expenses WHERE caregiver_schedule_entry_id = $1
               ) THEN 'gerado' ELSE 'valor_pendente' END
               WHERE id = $1`,
        params: [entry.id],
      });
    }
    if (commands.length >= 80) await flushCommands();
  }
  await flushCommands();
}

async function syncLegacyCaregiverPayrollForPatient(patientId: string, fromDate: string): Promise<void> {
  const entries = await query<{ id: string }>(
    `SELECT entry.id
     FROM caregiver_schedule_entries AS entry
     JOIN caregiver_assignments AS assignment ON assignment.id = entry.caregiver_assignment_id
     WHERE assignment.patient_id = $1 AND entry.scheduled_date >= $2`,
    [patientId, fromDate],
  );
  await syncLegacyCaregiverPayroll(entries.map((entry) => entry.id));
}

// ---------- Leads ----------
export async function listLeads(): Promise<Lead[]> {
  if (shouldUseSupabaseData()) return supabaseData.listLeads();
  return query<Lead>("SELECT * FROM leads ORDER BY created_at DESC");
}

export async function createLead(input: {
  name: string;
  email: string;
  phone: string;
  patient_name?: string;
  care_type?: string;
  message?: string;
}): Promise<Lead> {
  if (shouldUseSupabaseData()) return supabaseData.createLead(input);
  const id = randomUUID();
  const lead: Lead = {
    id,
    name: input.name,
    email: input.email,
    phone: input.phone,
    patient_name: input.patient_name || null,
    care_type: input.care_type || null,
    message: input.message || null,
    status: "novo",
    created_at: new Date().toISOString(),
  };
  await query(
    `INSERT INTO leads
      (id, name, email, phone, patient_name, care_type, message, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      lead.id,
      lead.name,
      lead.email,
      lead.phone,
      lead.patient_name,
      lead.care_type,
      lead.message,
      lead.status,
      lead.created_at,
    ]
  );
  return lead;
}

export async function updateLeadStatus(id: string, status: Lead["status"]): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.updateLeadStatus(id, status);
  await query("UPDATE leads SET status = $1 WHERE id = $2", [status, id]);
}

export async function deleteLead(id: string): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.deleteLead(id);
  await query("DELETE FROM leads WHERE id = $1", [id]);
}

// ---------- Professional applications ----------
export async function listProfessionalApplications(): Promise<ProfessionalApplication[]> {
  if (shouldUseSupabaseData()) return supabaseData.listProfessionalApplications();
  return query<ProfessionalApplication>("SELECT * FROM professional_applications ORDER BY created_at DESC");
}

export async function createProfessionalApplication(input: {
  name: string;
  email: string;
  phone: string;
  city?: string;
  profession: ProfessionalApplication["profession"];
  coren?: string;
  experience?: string;
  availability_days: string[];
  availability_shifts: string[];
  available_from?: string;
  notes?: string;
  lgpd_consent: true;
  privacy_notice_version: string;
}): Promise<ProfessionalApplication> {
  if (shouldUseSupabaseData()) return supabaseData.createProfessionalApplication(input);
  const id = randomUUID();
  await query(
    `INSERT INTO professional_applications
      (id, name, email, phone, city, profession, coren, experience, availability_days,
       availability_shifts, available_from, notes, status, lgpd_consent, lgpd_consent_at,
       privacy_notice_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'novo',$13,now(),$14)`,
    [
      id,
      input.name,
      input.email.toLowerCase().trim(),
      input.phone,
      input.city || null,
      input.profession,
      input.coren || null,
      input.experience || null,
      input.availability_days,
      input.availability_shifts,
      input.available_from || null,
      input.notes || null,
      input.lgpd_consent,
      input.privacy_notice_version,
    ]
  );
  return (await queryOne<ProfessionalApplication>("SELECT * FROM professional_applications WHERE id = $1", [id]))!;
}

export async function updateProfessionalApplicationStatus(
  id: string,
  status: ProfessionalApplication["status"],
  reviewedBy: string
): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.updateProfessionalApplicationStatus(id, status, reviewedBy);
  if (status === "aprovado") {
    const application = await queryOne<ProfessionalApplication>(
      "SELECT * FROM professional_applications WHERE id = $1",
      [id]
    );
    if (!application) throw new Error("Candidatura não encontrada.");

    await executeBatch([
      {
        text: `UPDATE professional_applications
               SET status = 'aprovado', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = $2
               WHERE id = $1`,
        params: [id, reviewedBy],
      },
      {
        text: `INSERT INTO caregiver_profiles
        (id, application_id, name, contact_email, phone, city, profession, coren, experience,
         availability_days, availability_shifts, available_from, notes, account_status, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'aguardando_acesso',CURRENT_TIMESTAMP)
       ON CONFLICT (application_id) DO UPDATE SET
         name = excluded.name,
         contact_email = excluded.contact_email,
         phone = excluded.phone,
         city = excluded.city,
         profession = excluded.profession,
         coren = excluded.coren,
         experience = excluded.experience,
         availability_days = excluded.availability_days,
         availability_shifts = excluded.availability_shifts,
         available_from = excluded.available_from,
         notes = excluded.notes,
         account_status = CASE
           WHEN caregiver_profiles.user_id IS NULL THEN 'aguardando_acesso'
           ELSE caregiver_profiles.account_status
         END`,
        params: [
          randomUUID(),
          application.id,
          application.name,
          application.email,
          application.phone,
          application.city,
          application.profession,
          application.coren,
          application.experience,
          application.availability_days,
          application.availability_shifts,
          application.available_from,
          application.notes,
        ],
      },
    ]);
    return;
  }

  if (status === "recusado") {
    await executeBatch([
      {
        text: `UPDATE professional_applications
               SET status = 'recusado', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = $2
               WHERE id = $1`,
        params: [id, reviewedBy],
      },
      {
        text: "UPDATE caregiver_profiles SET account_status = 'inativo' WHERE application_id = $1",
        params: [id],
      },
    ]);
    return;
  }

  await query(
    "UPDATE professional_applications SET status = $1, reviewed_at = now(), reviewed_by = $2 WHERE id = $3",
    [status, reviewedBy, id]
  );
}

export async function deleteProfessionalApplication(id: string): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.deleteProfessionalApplication(id);
  await query("DELETE FROM professional_applications WHERE id = $1", [id]);
}

// ---------- Caregiver bank ----------
export async function listCaregiverProfiles(): Promise<CaregiverProfile[]> {
  if (shouldUseSupabaseData()) return supabaseData.listCaregiverProfiles();
  return query<CaregiverProfile>(
    `SELECT cp.*, u.email AS access_email
     FROM caregiver_profiles cp
     LEFT JOIN users u ON u.id = cp.user_id
     ORDER BY cp.approved_at DESC, cp.name`
  );
}

export async function getCaregiverProfile(id: string): Promise<CaregiverProfile | undefined> {
  if (shouldUseSupabaseData()) return supabaseData.getCaregiverProfile(id);
  return queryOne<CaregiverProfile>(
    `SELECT cp.*, u.email AS access_email
     FROM caregiver_profiles cp
     LEFT JOIN users u ON u.id = cp.user_id
     WHERE cp.id = $1`,
    [id]
  );
}

export async function getCaregiverProfileByUserId(userId: string): Promise<CaregiverProfile | undefined> {
  if (shouldUseSupabaseData()) return supabaseData.getCaregiverProfileByUserId(userId);
  return queryOne<CaregiverProfile>(
    `SELECT cp.*, u.email AS access_email
     FROM caregiver_profiles cp
     LEFT JOIN users u ON u.id = cp.user_id
     WHERE cp.user_id = $1`,
    [userId]
  );
}

export async function updateCaregiverProfile(id: string, fields: CaregiverProfileUpdate): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.updateCaregiverProfile(id, fields);
  const allowed: (keyof CaregiverProfileUpdate)[] = [
    "name",
    "contact_email",
    "phone",
    "city",
    "profession",
    "coren",
    "experience",
    "availability_days",
    "availability_shifts",
    "available_from",
    "notes",
  ];
  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = $${index}`);
      values.push(fields[key] ?? null);
      index += 1;
    }
  }
  if (!sets.length) return;
  values.push(id);
  await query(`UPDATE caregiver_profiles SET ${sets.join(", ")} WHERE id = $${index}`, values);
}

export async function updateCaregiverUser(
  id: string,
  fields: CaregiverUserUpdate,
): Promise<CaregiverUserUpdateResult> {
  if (shouldUseSupabaseData()) return supabaseData.updateCaregiverUser(id, fields);

  const user = await queryOne<User>(
    "SELECT * FROM users WHERE id = $1 AND role = 'cuidador' AND deleted_at IS NULL",
    [id],
  );
  if (!user) throw new Error("Cadastro manual de profissional não encontrado.");

  const existingProfile = await queryOne<CaregiverProfile>(
    "SELECT * FROM caregiver_profiles WHERE user_id = $1",
    [id],
  );

  const allowed: (keyof CaregiverUserUpdate)[] = ["name", "phone"];
  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = $${index}`);
      values.push(fields[key] ?? null);
      index += 1;
    }
  }
  const commands: Array<{ text: string; params: unknown[] }> = [];
  if (sets.length) {
    values.push(id);
    commands.push({
      text: `UPDATE users SET ${sets.join(", ")} WHERE id = $${index} AND role = 'cuidador' AND deleted_at IS NULL`,
      params: values,
    });
  }

  const profileFields: (keyof CaregiverUserUpdate)[] = [
    "name",
    "phone",
    "profession",
    "availability_days",
    "availability_shifts",
    "available_from",
  ];

  if (existingProfile) {
    const profileSets: string[] = [];
    const profileValues: unknown[] = [];
    let profileIndex = 1;
    for (const key of profileFields) {
      if (!(key in fields)) continue;
      profileSets.push(`${key} = $${profileIndex}`);
      profileValues.push(key === "phone" ? fields.phone ?? "" : fields[key] ?? null);
      profileIndex += 1;
    }
    if (profileSets.length) {
      profileValues.push(existingProfile.id);
      commands.push({
        text: `UPDATE caregiver_profiles SET ${profileSets.join(", ")} WHERE id = $${profileIndex}`,
        params: profileValues,
      });
    }
    if (commands.length) await executeBatch(commands);
    return { profileId: existingProfile.id };
  }

  const profileId = randomUUID();
  const profileName = "name" in fields ? fields.name! : user.name;
  const profilePhone = "phone" in fields ? fields.phone ?? "" : user.phone ?? "";
  const profileProfession = fields.profession ?? "cuidador";
  commands.push({
    text: `INSERT INTO caregiver_profiles
      (id, application_id, user_id, name, contact_email, phone, profession,
       availability_days, availability_shifts, available_from, account_status, approved_at)
     VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,'ativo',CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       name = excluded.name,
       phone = excluded.phone,
       profession = excluded.profession,
       availability_days = excluded.availability_days,
       availability_shifts = excluded.availability_shifts,
       available_from = excluded.available_from`,
    params: [
      profileId,
      id,
      profileName,
      user.email,
      profilePhone,
      profileProfession,
      fields.availability_days ?? [],
      fields.availability_shifts ?? [],
      fields.available_from ?? null,
    ],
  });

  await executeBatch(commands);
  const persistedProfile = await queryOne<Pick<CaregiverProfile, "id">>(
    "SELECT id FROM caregiver_profiles WHERE user_id = $1",
    [id],
  );
  if (!persistedProfile?.id) throw new Error("O perfil profissional não foi persistido.");
  return { profileId: persistedProfile.id };
}

export async function createCaregiverAccess(input: {
  profileId: string;
  email: string;
  password: string;
}): Promise<User> {
  if (shouldUseSupabaseData()) return supabaseData.createCaregiverAccess(input);
  const profile = await getCaregiverProfile(input.profileId);
  if (!profile || profile.user_id || profile.account_status !== "aguardando_acesso") {
    throw new Error("Perfil não encontrado ou acesso já criado.");
  }
  if (await getUserByEmail(input.email.toLowerCase().trim())) {
    throw new Error("Este e-mail já está vinculado a outra conta.");
  }

  const userId = randomUUID();
  await executeBatch([
    {
      text: `INSERT INTO users (id, name, email, password_hash, role, phone)
             VALUES ($1,$2,$3,$4,'cuidador',$5)`,
      params: [
        userId,
        profile.name,
        input.email.toLowerCase().trim(),
        hashPassword(input.password),
        profile.phone,
      ],
    },
    {
      text: `UPDATE caregiver_profiles
             SET user_id = $1, account_status = 'ativo'
             WHERE id = $2 AND user_id IS NULL AND account_status = 'aguardando_acesso'`,
      params: [userId, input.profileId],
    },
  ]);
  return (await getUserById(userId))!;
}

async function contractKeysOwnedBy(column: string, ownerId: string): Promise<string[]> {
  const contracts = await query<{ storage_key: string }>(
    `SELECT storage_key FROM contract_documents WHERE ${column} = $1`,
    [ownerId]
  );
  return contracts.map((contract) => contract.storage_key);
}

async function cleanupStoredContracts(keys: string[]): Promise<void> {
  try {
    await deleteStoredFiles(keys);
  } catch (error) {
    console.error("[contracts] Metadados removidos, mas alguns arquivos não puderam ser limpos.", {
      error: error instanceof Error ? error.message : "Erro desconhecido",
    });
  }
}

export async function deleteCaregiverProfile(id: string): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.deleteCaregiverProfile(id);
  const profile = await getCaregiverProfile(id);
  if (!profile) return;
  if (profile.user_id) {
    const scheduledEntry = await queryOne<{ id: string }>(
      `SELECT s.id FROM caregiver_schedule_entries s
       JOIN caregiver_assignments a ON a.id = s.caregiver_assignment_id
       WHERE a.caregiver_user_id = $1 LIMIT 1`,
      [profile.user_id],
    );
    if (scheduledEntry) throw new ScheduleHistoryConflictError();
  }
  const keys = await contractKeysOwnedBy("caregiver_profile_id", id);
  if (profile.user_id) {
    keys.push(...(await contractKeysOwnedBy("caregiver_user_id", profile.user_id)));
  }
  const commands: Array<{ text: string; params: unknown[] }> = [
    { text: "DELETE FROM contract_documents WHERE caregiver_profile_id = $1", params: [id] },
  ];
  if (profile.user_id) {
    commands.push(
      { text: "DELETE FROM contract_documents WHERE caregiver_user_id = $1", params: [profile.user_id] },
      { text: "DELETE FROM caregiver_assignments WHERE caregiver_user_id = $1", params: [profile.user_id] }
    );
  }
  commands.push({ text: "DELETE FROM caregiver_profiles WHERE id = $1", params: [id] });
  if (profile.user_id) {
    commands.push(
      {
        text: `UPDATE users
               SET name = 'Profissional removido', email = $1, phone = NULL, password_hash = $2,
                   session_version = session_version + 1, deleted_at = now()
               WHERE id = $3 AND role = 'cuidador' AND deleted_at IS NULL`,
        params: [
          `removido-${profile.user_id}@anonimo.vellora.invalid`,
          hashPassword(randomUUID()),
          profile.user_id,
        ],
      },
      { text: "DELETE FROM password_reset_tokens WHERE user_id = $1", params: [profile.user_id] }
    );
  }
  await executeBatch(commands);
  await cleanupStoredContracts(keys);
}

export async function deleteCaregiverUser(id: string): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.deleteCaregiverUser(id);
  const scheduledEntry = await queryOne<{ id: string }>(
    `SELECT s.id FROM caregiver_schedule_entries s
     JOIN caregiver_assignments a ON a.id = s.caregiver_assignment_id
     WHERE a.caregiver_user_id = $1 LIMIT 1`,
    [id],
  );
  if (scheduledEntry) throw new ScheduleHistoryConflictError();
  const keys = await contractKeysOwnedBy("caregiver_user_id", id);
  await executeBatch([
    { text: "DELETE FROM contract_documents WHERE caregiver_user_id = $1", params: [id] },
    { text: "DELETE FROM caregiver_assignments WHERE caregiver_user_id = $1", params: [id] },
    {
      text: `UPDATE users
             SET name = 'Profissional removido', email = $1, phone = NULL, password_hash = $2,
                 session_version = session_version + 1, deleted_at = now()
             WHERE id = $3 AND role = 'cuidador' AND deleted_at IS NULL`,
      params: [`removido-${id}@anonimo.vellora.invalid`, hashPassword(randomUUID()), id],
    },
    { text: "DELETE FROM password_reset_tokens WHERE user_id = $1", params: [id] },
  ]);
  await cleanupStoredContracts(keys);
}

export async function deleteFamilyUser(id: string): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.deleteFamilyUser(id);
  const keys = await contractKeysOwnedBy("family_user_id", id);
  const linkedPatients = await query<{ id: string }>(
    "SELECT id FROM patients WHERE family_user_id = $1",
    [id],
  );
  await executeBatch([
    { text: "UPDATE patients SET family_user_id = NULL WHERE family_user_id = $1", params: [id] },
    { text: "DELETE FROM contract_documents WHERE family_user_id = $1", params: [id] },
    {
      text: `UPDATE users
             SET name = 'Conta de família removida', email = $1, phone = NULL, password_hash = $2,
                 session_version = session_version + 1, deleted_at = now()
             WHERE id = $3 AND role = 'familia' AND deleted_at IS NULL`,
      params: [`removido-${id}@anonimo.vellora.invalid`, hashPassword(randomUUID()), id],
    },
    { text: "DELETE FROM password_reset_tokens WHERE user_id = $1", params: [id] },
  ]);
  for (const patient of linkedPatients) {
    await syncLegacyCaregiverPayrollForPatient(patient.id, brazilToday());
  }
  await cleanupStoredContracts(keys);
}

// ---------- Contract documents ----------
export type ContractOwnerType = "family" | "caregiver_profile" | "caregiver_user";

function contractOwnerWhere(ownerType: ContractOwnerType): string {
  if (ownerType === "family") return "family_user_id";
  if (ownerType === "caregiver_profile") return "caregiver_profile_id";
  return "caregiver_user_id";
}

export async function listContractDocuments(
  ownerType: ContractOwnerType,
  ownerId: string
): Promise<ContractDocument[]> {
  if (shouldUseSupabaseData()) return supabaseData.listContractDocuments(ownerType, ownerId);
  const column = contractOwnerWhere(ownerType);
  return query<ContractDocument>(
    `SELECT id, family_user_id, caregiver_profile_id, caregiver_user_id,
            file_name, mime_type, file_size, uploaded_by, created_at
     FROM contract_documents
     WHERE ${column} = $1
     ORDER BY created_at DESC`,
    [ownerId]
  );
}

export async function listContractDocumentsForCaregiver(userId: string): Promise<ContractDocument[]> {
  if (shouldUseSupabaseData()) return supabaseData.listContractDocumentsForCaregiver(userId);
  return query<ContractDocument>(
    `SELECT cd.id, cd.family_user_id, cd.caregiver_profile_id, cd.caregiver_user_id,
            cd.file_name, cd.mime_type, cd.file_size, cd.uploaded_by, cd.created_at
     FROM contract_documents cd
     LEFT JOIN caregiver_profiles cp ON cp.id = cd.caregiver_profile_id
     WHERE cd.caregiver_user_id = $1 OR cp.user_id = $1
     ORDER BY cd.created_at DESC`,
    [userId]
  );
}

export async function getContractDocument(id: string): Promise<ContractDocument | undefined> {
  if (shouldUseSupabaseData()) return supabaseData.getContractDocument(id);
  return queryOne<ContractDocument>(
    `SELECT id, family_user_id, caregiver_profile_id, caregiver_user_id,
            file_name, mime_type, file_size, uploaded_by, created_at
     FROM contract_documents WHERE id = $1`,
    [id]
  );
}

export async function getContractFileData(id: string): Promise<Uint8Array | null> {
  if (shouldUseSupabaseData()) return supabaseData.getContractFileData(id);
  const contract = await queryOne<StoredContractDocument>(
    "SELECT * FROM contract_documents WHERE id = $1",
    [id]
  );
  return contract ? getStoredFile(contract.storage_key) : null;
}

export async function createContractDocument(input: {
  ownerType: ContractOwnerType;
  ownerId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileData: Uint8Array;
  uploadedBy: string;
}): Promise<ContractDocument> {
  if (shouldUseSupabaseData()) return supabaseData.createContractDocument(input);
  const id = randomUUID();
  const storageKey = `contracts/${id}.pdf`;
  const familyUserId = input.ownerType === "family" ? input.ownerId : null;
  const caregiverProfileId = input.ownerType === "caregiver_profile" ? input.ownerId : null;
  const caregiverUserId = input.ownerType === "caregiver_user" ? input.ownerId : null;
  await putStoredFile(storageKey, input.fileData, input.mimeType);
  try {
    await query(
      `INSERT INTO contract_documents
        (id, family_user_id, caregiver_profile_id, caregiver_user_id, file_name,
         mime_type, file_size, storage_key, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        familyUserId,
        caregiverProfileId,
        caregiverUserId,
        input.fileName,
        input.mimeType,
        input.fileSize,
        storageKey,
        input.uploadedBy,
      ]
    );
  } catch (error) {
    await deleteStoredFile(storageKey).catch(() => undefined);
    throw error;
  }
  return (await queryOne<ContractDocument>(
    `SELECT id, family_user_id, caregiver_profile_id, caregiver_user_id,
            file_name, mime_type, file_size, uploaded_by, created_at
     FROM contract_documents WHERE id = $1`,
    [id]
  ))!;
}

/**
 * Registers a contract whose bytes were already written directly to Storage.
 * The Supabase implementation uses the upload UUID as the database id so a
 * retry after a network timeout is safe and does not create a duplicate row.
 */
export async function registerStoredContractDocument(
  input: StoredContractDocumentInput,
): Promise<ContractDocument> {
  if (shouldUseSupabaseData()) return supabaseData.registerStoredContractDocument(input);
  throw new Error("Upload direto de contratos exige o provider Supabase.");
}

export async function isContractStorageKeyRegistered(storageKey: string): Promise<boolean> {
  if (shouldUseSupabaseData()) return supabaseData.isContractStorageKeyRegistered(storageKey);
  const row = await queryOne<{ id: string }>(
    "SELECT id FROM contract_documents WHERE storage_key = $1 LIMIT 1",
    [storageKey],
  );
  return Boolean(row);
}

export async function deleteContractDocument(id: string): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.deleteContractDocument(id);
  const contract = await queryOne<{ storage_key: string }>(
    "SELECT storage_key FROM contract_documents WHERE id = $1",
    [id]
  );
  await query("DELETE FROM contract_documents WHERE id = $1", [id]);
  if (contract) await cleanupStoredContracts([contract.storage_key]);
}

// ---------- Daily records ----------
export async function listRecordsForPatient(patientId: string, limit = 90): Promise<DailyRecord[]> {
  if (shouldUseSupabaseData()) return supabaseData.listRecordsForPatient(patientId, limit);
  return query<DailyRecord>(
    "SELECT * FROM daily_records WHERE patient_id = $1 ORDER BY record_date DESC, record_time DESC NULLS LAST, created_at DESC LIMIT $2",
    [patientId, limit]
  );
}

export async function getRecord(id: string): Promise<DailyRecord | undefined> {
  if (shouldUseSupabaseData()) return supabaseData.getRecord(id);
  return queryOne<DailyRecord>("SELECT * FROM daily_records WHERE id = $1", [id]);
}

export async function getRecordForCaregiverOnDate(
  patientId: string,
  caregiverUserId: string,
  recordDate: string
): Promise<DailyRecord | undefined> {
  if (shouldUseSupabaseData()) return supabaseData.getRecordForCaregiverOnDate(patientId, caregiverUserId, recordDate);
  return queryOne<DailyRecord>(
    `SELECT * FROM daily_records
     WHERE patient_id = $1 AND caregiver_user_id = $2 AND record_date = $3
     ORDER BY record_time DESC, created_at DESC
     LIMIT 1`,
    [patientId, caregiverUserId, recordDate]
  );
}

export async function createRecord(
  input: Omit<DailyRecord, "id" | "created_at" | "updated_at">,
  actor: RecordAuditActor = { userId: input.caregiver_user_id, name: "Cuidador" }
): Promise<DailyRecord> {
  if (shouldUseSupabaseData()) return supabaseData.createRecord(input, actor);
  const id = randomUUID();
  await executeBatch([
    {
      text: `INSERT INTO daily_records
        (id, patient_id, caregiver_user_id, record_date, record_time, bp_systolic, bp_diastolic, heart_rate, temperature, spo2, glucose,
         medications, feeding, hygiene, mobility, mood, pain_level, notes, incident, incident_description, photo_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      params: [
        id,
        input.patient_id,
        input.caregiver_user_id,
        input.record_date,
        input.record_time,
        input.bp_systolic,
        input.bp_diastolic,
        input.heart_rate,
        input.temperature,
        input.spo2,
        input.glucose,
        input.medications,
        input.feeding,
        input.hygiene,
        input.mobility,
        input.mood,
        input.pain_level,
        input.notes,
        input.incident,
        input.incident_description,
        input.photo_data,
      ],
    },
    {
      text: `INSERT INTO daily_record_audit_events
        (id, record_id, patient_id, actor_user_id, actor_name, action, changed_fields, after_data)
       VALUES ($1,$2,$3,$4,$5,'created',$6,$7)`,
      params: [
        randomUUID(),
        id,
        input.patient_id,
        actor.userId,
        actor.name.slice(0, 160),
        JSON.stringify(Object.keys(snapshotDailyRecord(input))),
        JSON.stringify(snapshotDailyRecord(input)),
      ],
    },
  ]);
  return (await getRecord(id))!;
}

export async function updateRecord(
  id: string,
  fields: Partial<Omit<DailyRecord, "id" | "created_at" | "updated_at" | "patient_id" | "caregiver_user_id">>,
  actor: RecordAuditActor
): Promise<DailyRecord | undefined> {
  if (shouldUseSupabaseData()) return supabaseData.updateRecord(id, fields, actor);
  const existing = await getRecord(id);
  if (!existing) return undefined;

  const merged = { ...existing, ...fields };
  const changedFields = diffDailyRecord(existing, merged);
  if (changedFields.length === 0) return existing;

  const allowed = [
    "record_date",
    "record_time",
    "bp_systolic",
    "bp_diastolic",
    "heart_rate",
    "temperature",
    "spo2",
    "glucose",
    "medications",
    "feeding",
    "hygiene",
    "mobility",
    "mood",
    "pain_level",
    "notes",
    "incident",
    "incident_description",
    "photo_data",
  ] as const;
  const sets: string[] = [];
  const params: unknown[] = [];
  let parameterIndex = 1;
  for (const field of allowed) {
    if (!(field in fields)) continue;
    sets.push(`${field} = $${parameterIndex}`);
    params.push(fields[field]);
    parameterIndex += 1;
  }
  sets.push("updated_at = CURRENT_TIMESTAMP");
  params.push(id);

  await executeBatch([
    {
      text: `UPDATE daily_records SET ${sets.join(", ")} WHERE id = $${parameterIndex}`,
      params,
    },
    {
      text: `INSERT INTO daily_record_audit_events
        (id, record_id, patient_id, actor_user_id, actor_name, action, changed_fields, before_data, after_data)
       VALUES ($1,$2,$3,$4,$5,'updated',$6,$7,$8)`,
      params: [
        randomUUID(),
        id,
        existing.patient_id,
        actor.userId,
        actor.name.slice(0, 160),
        JSON.stringify(changedFields),
        JSON.stringify(snapshotDailyRecord(existing)),
        JSON.stringify(snapshotDailyRecord(merged)),
      ],
    },
  ]);

  return (await getRecord(id))!;
}

export async function deleteRecord(id: string): Promise<boolean> {
  if (shouldUseSupabaseData()) return supabaseData.deleteRecord(id);
  const existing = await getRecord(id);
  if (!existing) return false;
  await query("DELETE FROM daily_records WHERE id = $1", [id]);
  return true;
}

export async function listRecordAuditForPatient(
  patientId: string,
  limit = 50
): Promise<DailyRecordAuditEvent[]> {
  if (shouldUseSupabaseData()) return supabaseData.listRecordAuditForPatient(patientId, limit);
  return query<DailyRecordAuditEvent>(
    `SELECT * FROM daily_record_audit_events
     WHERE patient_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [patientId, limit]
  );
}

export async function countPendingLeads(): Promise<number> {
  if (shouldUseSupabaseData()) return supabaseData.countPendingLeads();
  const result = await queryOne<{ total: number }>(
    "SELECT COUNT(*) AS total FROM leads WHERE status IN ('novo','em_contato')"
  );
  return Number(result?.total || 0);
}

export async function getCaregiverName(id: string): Promise<string> {
  if (shouldUseSupabaseData()) return supabaseData.getCaregiverName(id);
  const u = await getUserById(id);
  return u ? u.name : "Cuidador";
}

/** Busca vários usuários de uma vez e devolve um mapa id -> nome (evita N chamadas em loops). */
export async function getCaregiverNamesMap(ids: string[]): Promise<Record<string, string>> {
  if (shouldUseSupabaseData()) return supabaseData.getCaregiverNamesMap(ids);
  const uniqueIds = [...new Set(ids)];
  const users = await getUsersByIds(uniqueIds);
  const map: Record<string, string> = {};
  for (const u of users) map[u.id] = u.name;
  return map;
}

async function getLegacyFinanceCharge(id: string): Promise<FinanceCharge | undefined> {
  return queryOne<FinanceCharge>(
    `SELECT charge.id, charge.label, charge.competence_month, charge.due_date,
            charge.amount_cents, COALESCE(SUM(receipt.amount_cents), 0) AS received_cents,
            charge.created_at, charge.updated_at
     FROM finance_charges charge
     LEFT JOIN finance_receipts receipt ON receipt.charge_id = charge.id
     WHERE charge.id = $1
     GROUP BY charge.id`,
    [id],
  );
}

export async function getFinanceDashboardSnapshot(month: string): Promise<FinanceDashboardSnapshot> {
  if (shouldUseSupabaseData()) return supabaseData.getFinanceDashboardSnapshot(month);
  const range = financeChartRange(month);
  const monthStart = `${month}-01`;
  const monthEnd = `${shiftFinanceMonth(month, 1)}-01`;
  const [charges, expenses, receipts, payments] = await Promise.all([
    query<FinanceCharge>(
      `SELECT charge.id, charge.label, charge.competence_month, charge.due_date,
              charge.amount_cents, COALESCE(SUM(receipt.amount_cents), 0) AS received_cents,
              charge.created_at, charge.updated_at
       FROM finance_charges charge
       LEFT JOIN finance_receipts receipt ON receipt.charge_id = charge.id
       WHERE charge.competence_month = $1
       GROUP BY charge.id
       ORDER BY charge.due_date ASC, charge.created_at ASC`,
      [month],
    ),
    query<FinanceExpense>(
      `SELECT expense.id, expense.expense_date, expense.category, expense.description,
              expense.amount_cents, expense.paid_on, expense.caregiver_schedule_entry_id,
              patient.name AS patient_name, expense.caregiver_user_id, expense.payee,
              expense.caregiver_payroll_amount_overridden, expense.created_at, expense.updated_at
       FROM finance_expenses AS expense
       LEFT JOIN caregiver_schedule_entries AS entry
         ON entry.id = expense.caregiver_schedule_entry_id
       LEFT JOIN caregiver_assignments AS assignment
         ON assignment.id = entry.caregiver_assignment_id
       LEFT JOIN patients AS patient ON patient.id = assignment.patient_id
       WHERE expense.expense_date >= $1 AND expense.expense_date < $2
       ORDER BY expense.expense_date DESC, expense.created_at DESC`,
      [monthStart, monthEnd],
    ),
    query<FinanceReceiptMovement>(
      "SELECT received_on, amount_cents FROM finance_receipts WHERE received_on >= $1 AND received_on < $2",
      [range.start, range.end],
    ),
    query<FinanceExpensePaymentMovement>(
      "SELECT paid_on, amount_cents FROM finance_expenses WHERE paid_on >= $1 AND paid_on < $2",
      [range.start, range.end],
    ),
  ]);

  return {
    month,
    charges,
    expenses,
    cash_flow: buildFinanceCashFlow(month, receipts, payments),
  };
}

export async function createFinanceCharge(
  input: FinanceChargeInput,
  actorId: string,
): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.createFinanceCharge(input, actorId);
  await query(
    `INSERT INTO finance_charges
      (id, label, competence_month, due_date, amount_cents, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), input.label, input.competence_month, input.due_date, input.amount_cents, actorId],
  );
}

export async function updateFinanceCharge(id: string, input: FinanceChargeInput): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.updateFinanceCharge(id, input);
  const current = await getLegacyFinanceCharge(id);
  if (!current) throw new FinanceNotFoundError("Cobrança não encontrada.");
  if (input.amount_cents < current.received_cents) {
    throw new FinanceConflictError("O valor da cobrança não pode ficar abaixo dos recebimentos já registrados.");
  }
  await query(
    `UPDATE finance_charges
     SET label = $1, competence_month = $2, due_date = $3, amount_cents = $4,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $5`,
    [input.label, input.competence_month, input.due_date, input.amount_cents, id],
  );
}

export async function deleteFinanceCharge(id: string): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.deleteFinanceCharge(id);
  if (!(await getLegacyFinanceCharge(id))) throw new FinanceNotFoundError("Cobrança não encontrada.");
  await query("DELETE FROM finance_charges WHERE id = $1", [id]);
}

export async function recordFinanceReceipt(
  chargeId: string,
  input: FinanceReceiptInput,
  actorId: string,
): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.recordFinanceReceipt(chargeId, input, actorId);
  const charge = await getLegacyFinanceCharge(chargeId);
  if (!charge) throw new FinanceNotFoundError("Cobrança não encontrada.");
  if (charge.received_cents + input.amount_cents > charge.amount_cents) {
    throw new FinanceConflictError();
  }
  await query(
    `INSERT INTO finance_receipts (id, charge_id, received_on, amount_cents, created_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), chargeId, input.received_on, input.amount_cents, actorId],
  );
}

export async function createFinanceExpense(
  input: FinanceExpenseInput,
  actorId: string,
): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.createFinanceExpense(input, actorId);
  await query(
    `INSERT INTO finance_expenses
      (id, expense_date, category, description, amount_cents, paid_on, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      randomUUID(),
      input.expense_date,
      input.category,
      input.description,
      input.amount_cents,
      input.paid_on,
      actorId,
    ],
  );
}

export async function updateFinanceExpense(id: string, input: FinanceExpenseInput): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.updateFinanceExpense(id, input);
  const current = await queryOne<{ id: string; category: FinanceExpenseCategory; caregiver_schedule_entry_id: string | null }>(
    "SELECT id, category, caregiver_schedule_entry_id FROM finance_expenses WHERE id = $1",
    [id],
  );
  if (!current) throw new FinanceNotFoundError("Despesa não encontrada.");
  if (current.category === "equipe" || current.caregiver_schedule_entry_id) {
    throw new FinanceConflictError("Este valor é calculado pela escala. Atualize apenas a data de pagamento.");
  }
  await query(
    `UPDATE finance_expenses
     SET expense_date = $1, category = $2, description = $3, amount_cents = $4,
         paid_on = $5, updated_at = CURRENT_TIMESTAMP
     WHERE id = $6`,
    [input.expense_date, input.category, input.description, input.amount_cents, input.paid_on, id],
  );
}

export async function updateFinancePayrollExpense(
  id: string,
  input: FinancePayrollExpenseUpdate,
): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.updateFinancePayrollExpense(id, input);
  const current = await queryOne<{
    id: string;
    caregiver_schedule_entry_id: string | null;
    amount_cents: number;
    caregiver_payroll_amount_overridden: boolean;
  }>(
    `SELECT id, caregiver_schedule_entry_id, amount_cents, caregiver_payroll_amount_overridden
     FROM finance_expenses WHERE id = $1 AND category = 'equipe'`,
    [id],
  );
  if (!current) throw new FinanceNotFoundError("Pagamento de plantão não encontrado.");
  if (!current.caregiver_schedule_entry_id) {
    throw new FinanceConflictError("Este pagamento pertence a uma escala removida e foi preservado como histórico.");
  }
  await query(
    `UPDATE finance_expenses
     SET amount_cents = $1,
         paid_on = $2,
         caregiver_payroll_amount_overridden = CASE
           WHEN $1 <> amount_cents THEN 1 ELSE caregiver_payroll_amount_overridden END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3 AND category = 'equipe'`,
    [input.amount_cents, input.paid_on, id],
  );
}

export async function updateFinanceExpensePayment(id: string, paidOn: string | null): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.updateFinanceExpensePayment(id, paidOn);
  const current = await queryOne<{ id: string; caregiver_schedule_entry_id: string | null }>(
    "SELECT id, caregiver_schedule_entry_id FROM finance_expenses WHERE id = $1 AND category = 'equipe'",
    [id],
  );
  if (!current) throw new FinanceNotFoundError("Pagamento de plantão não encontrado.");
  if (!current.caregiver_schedule_entry_id) {
    throw new FinanceConflictError("Este pagamento pertence a uma escala removida e foi preservado como histórico.");
  }
  await query(
    "UPDATE finance_expenses SET paid_on = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND category = 'equipe'",
    [paidOn, id],
  );
}

export async function deleteFinanceExpense(id: string): Promise<void> {
  if (shouldUseSupabaseData()) return supabaseData.deleteFinanceExpense(id);
  const current = await queryOne<{ id: string; category: FinanceExpenseCategory; caregiver_schedule_entry_id: string | null }>(
    "SELECT id, category, caregiver_schedule_entry_id FROM finance_expenses WHERE id = $1",
    [id],
  );
  if (!current) throw new FinanceNotFoundError("Despesa não encontrada.");
  if (current.category === "equipe" || current.caregiver_schedule_entry_id) {
    throw new FinanceConflictError("Este lançamento é gerado pela escala e não pode ser excluído manualmente.");
  }
  await query("DELETE FROM finance_expenses WHERE id = $1", [id]);
}
