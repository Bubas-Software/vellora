import { randomUUID } from "crypto";
import { createClient, type SupabaseClient, type User as SupabaseAuthUser } from "@supabase/supabase-js";
import { runtimeValue } from "../runtime-config";
import { resolveAuthProvider } from "../auth-provider";
import {
  createSupabaseServerClient,
} from "./server";
import { validateSupabaseConfig } from "./config";
import type {
  Assignment,
  CaregiverScheduleEntry,
  CaregiverScheduleEntryInput,
  CaregiverProfile,
  CaregiverProfileUpdate,
  CaregiverUserUpdate,
  CaregiverUserUpdateResult,
  ContractDocument,
  ContractOwnerType,
  DailyRecord,
  DailyRecordAuditEvent,
  FinanceCharge,
  FinanceChargeInput,
  FinanceDashboardSnapshot,
  FinanceExpense,
  FinanceExpenseCategory,
  FinanceExpenseInput,
  FinancePayrollExpenseUpdate,
  FinanceExpensePaymentMovement,
  FinanceReceiptInput,
  FinanceReceiptMovement,
  FamilyPatientServiceRate,
  FamilyPatientServiceRateInput,
  FamilyContractedService,
  FamilyUserUpdate,
  Lead,
  Patient,
  ProfessionalApplication,
  RecordAuditActor,
  StoredContractDocumentInput,
  User,
} from "../data";
import { diffDailyRecord, snapshotDailyRecord } from "../record-utils";
import {
  deleteStoredFile,
  deleteStoredFiles,
  getStoredFile,
  putStoredFile,
} from "../storage";
import {
  ASSIGNMENT_ACTIVE_CONFLICT_MESSAGE,
  ASSIGNMENT_DUPLICATE_CONFLICT_MESSAGE,
  ASSIGNMENT_HISTORY_CONFLICT_MESSAGE,
  AssignmentConflictError,
  isAssignmentUniqueViolation,
} from "../assignment-errors";
import { DUPLICATE_ACCOUNT_EMAIL_MESSAGE, isDuplicateAccountEmailError } from "../user-errors";
import { ScheduleHistoryConflictError } from "../schedule-errors";
import { FinanceConflictError, FinanceNotFoundError } from "../finance-errors";
import { buildFinanceCashFlow, financeChartRange, shiftFinanceMonth } from "../finance-utils";

export type DataProvider = "legacy" | "supabase";

export class SupabaseDataError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "SupabaseDataError";
    this.code = code;
  }
}

/**
 * Resolves the data backend without enabling Supabase accidentally. The empty
 * value is deliberately compatible with the existing D1 runtime.
 */
export function resolveDataProvider(value: string | undefined): DataProvider {
  return value?.trim().toLowerCase() === "supabase" ? "supabase" : "legacy";
}

export function getDataProvider(): DataProvider {
  return resolveDataProvider(runtimeValue("VELLORA_DATA_PROVIDER"));
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLE_VALUES = new Set<User["role"]>(["admin", "coordenador_operacional", "familia", "cuidador"]);
const PROFESSIONAL_STATUS_VALUES = new Set<ProfessionalApplication["status"]>([
  "novo",
  "em_analise",
  "aprovado",
  "recusado",
]);
const PROFESSIONAL_VALUES = new Set<ProfessionalApplication["profession"]>([
  "cuidador",
  "tecnico_enfermagem",
  "enfermeiro",
  "outros",
]);
const LEAD_STATUS_VALUES = new Set<Lead["status"]>([
  "novo",
  "em_contato",
  "convertido",
  "recusado",
]);
const CAREGIVER_STATUS_VALUES = new Set<CaregiverProfile["account_status"]>([
  "aguardando_acesso",
  "ativo",
  "inativo",
]);
const FINANCE_EXPENSE_CATEGORY_VALUES = new Set<FinanceExpenseCategory>([
  "marketing",
  "sistema",
  "contabilidade",
  "impostos",
  "equipe",
  "operacao",
  "outros",
]);

// Family and caregiver portals do not display the administrative patient
// notes. Keeping the projection explicit prevents those columns from being
// selected by ordinary portal reads while preserving full rows for admin
// operations below.
const PORTAL_PATIENT_COLUMNS =
  "id, name, birth_date, address, care_level, condition_summary, family_user_id, status, created_at";

function serverOnly(): void {
  if (typeof window !== "undefined") {
    throw new SupabaseDataError("O adapter de dados Supabase só pode ser usado no servidor.");
  }
}

function assertUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new SupabaseDataError(`${label} não é um UUID Supabase válido.`);
  }
  return value;
}

function assertAuthAndDataProviders(): void {
  if (resolveAuthProvider(runtimeValue("VELLORA_AUTH_PROVIDER")) !== "supabase") {
    throw new SupabaseDataError(
      "VELLORA_DATA_PROVIDER=supabase exige VELLORA_AUTH_PROVIDER=supabase para evitar misturar IDs D1 e Supabase.",
    );
  }
}

function publicConfig() {
  return validateSupabaseConfig(
    runtimeValue("NEXT_PUBLIC_SUPABASE_URL") || runtimeValue("SUPABASE_URL"),
    runtimeValue("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") ||
      runtimeValue("SUPABASE_PUBLISHABLE_KEY") ||
      runtimeValue("NEXT_PUBLIC_SUPABASE_ANON_KEY") ||
      runtimeValue("SUPABASE_ANON_KEY"),
  );
}

async function requestClient(): Promise<SupabaseClient> {
  serverOnly();
  assertAuthAndDataProviders();
  // This client carries the current request's cookies and therefore enforces
  // the caller's RLS policies on every ordinary application operation.
  return createSupabaseServerClient();
}

function serviceClient(): SupabaseClient {
  serverOnly();
  assertAuthAndDataProviders();
  const config = publicConfig();
  const serviceKey =
    runtimeValue("SUPABASE_SECRET_KEY") || runtimeValue("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey?.trim()) {
    throw new SupabaseDataError(
      "Configure SUPABASE_SECRET_KEY (ou SUPABASE_SERVICE_ROLE_KEY) somente no servidor para operações internas Supabase.",
    );
  }

  // This client is intentionally never imported by a browser entry point. It
  // is reserved for Auth Admin, public intake and server-side audit writes,
  // which are denied to anon/authenticated by the production policies.
  return createClient(config.url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

type SupabaseRow = Record<string, unknown>;

function operationError(context: string, error: unknown): SupabaseDataError {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const message =
    error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message
      : "erro desconhecido";
  return new SupabaseDataError(`${context}: ${message}`, code);
}

function requireNoError(context: string, error: unknown): void {
  if (error) throw operationError(context, error);
}

function requireValue<T>(context: string, data: T | null | undefined, error: unknown): T {
  requireNoError(context, error);
  if (data == null) throw new SupabaseDataError(`${context}: nenhum registro retornado.`);
  return data;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  const message = "message" in error && typeof error.message === "string" ? error.message.toLowerCase() : "";
  return code === "23505" || message.includes("duplicate key") || message.includes("unique constraint");
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asJsonString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function asRole(value: unknown): User["role"] {
  if (typeof value === "string" && ROLE_VALUES.has(value as User["role"])) {
    return value as User["role"];
  }
  throw new SupabaseDataError("Perfil Supabase contém um papel inválido.");
}

function asLeadStatus(value: unknown): Lead["status"] {
  if (typeof value === "string" && LEAD_STATUS_VALUES.has(value as Lead["status"])) {
    return value as Lead["status"];
  }
  throw new SupabaseDataError("Lead Supabase contém um status inválido.");
}

function asProfessionalStatus(value: unknown): ProfessionalApplication["status"] {
  if (
    typeof value === "string" &&
    PROFESSIONAL_STATUS_VALUES.has(value as ProfessionalApplication["status"])
  ) {
    return value as ProfessionalApplication["status"];
  }
  throw new SupabaseDataError("Candidatura Supabase contém um status inválido.");
}

function asProfession(value: unknown): ProfessionalApplication["profession"] {
  if (typeof value === "string" && PROFESSIONAL_VALUES.has(value as ProfessionalApplication["profession"])) {
    return value as ProfessionalApplication["profession"];
  }
  throw new SupabaseDataError("Perfil profissional Supabase contém uma profissão inválida.");
}

function asCaregiverStatus(value: unknown): CaregiverProfile["account_status"] {
  if (typeof value === "string" && CAREGIVER_STATUS_VALUES.has(value as CaregiverProfile["account_status"])) {
    return value as CaregiverProfile["account_status"];
  }
  throw new SupabaseDataError("Perfil de cuidador Supabase contém um status inválido.");
}

function mapFinanceExpenseCategory(value: unknown): FinanceExpenseCategory {
  if (
    typeof value === "string" &&
    FINANCE_EXPENSE_CATEGORY_VALUES.has(value as FinanceExpenseCategory)
  ) {
    return value as FinanceExpenseCategory;
  }
  throw new SupabaseDataError("Despesa Supabase contém uma categoria inválida.");
}

function mapFinanceCharge(row: SupabaseRow, receivedCents: number): FinanceCharge {
  return {
    id: assertUuid(asString(row.id), "Cobrança"),
    label: asString(row.label),
    competence_month: asString(row.competence_month).slice(0, 7),
    due_date: asString(row.due_date),
    amount_cents: asNumber(row.amount_cents) ?? 0,
    received_cents: receivedCents,
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
  };
}

function mapFinanceExpense(row: SupabaseRow, patientName: string | null = null): FinanceExpense {
  return {
    id: assertUuid(asString(row.id), "Despesa"),
    expense_date: asString(row.expense_date),
    category: mapFinanceExpenseCategory(row.category),
    description: asString(row.description),
    amount_cents: asNumber(row.amount_cents) ?? 0,
    paid_on: asNullableString(row.paid_on),
    caregiver_schedule_entry_id: asNullableString(row.caregiver_schedule_entry_id),
    patient_name: patientName,
    caregiver_user_id: asNullableString(row.caregiver_user_id),
    payee: asNullableString(row.payee),
    caregiver_payroll_amount_overridden: asBoolean(row.caregiver_payroll_amount_overridden),
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
  };
}

function normalizeTime(value: unknown): string | null {
  const result = asNullableString(value);
  return result ? result.slice(0, 5) : null;
}

function mapProfile(row: SupabaseRow, authUser?: SupabaseAuthUser | null): User {
  const active = asBoolean(row.active);
  return {
    id: assertUuid(asString(row.id), "Perfil"),
    name: asString(row.name, authUser?.email || "Usuário Vellora"),
    email: asString(authUser?.email),
    // Supabase Auth owns passwords. This empty compatibility field must never
    // be read by the Supabase login path or treated as a password hash.
    password_hash: "",
    role: asRole(row.role),
    phone: asNullableString(row.phone),
    session_version: 0,
    deleted_at: active ? null : asNullableString(row.updated_at) || asNullableString(row.created_at),
    created_at: asString(row.created_at),
  };
}

function mapPatient(row: SupabaseRow): Patient {
  const status = asString(row.status);
  if (status !== "pendente" && status !== "ativo" && status !== "inativo") {
    throw new SupabaseDataError("Paciente Supabase contém um status inválido.");
  }
  return {
    id: assertUuid(asString(row.id), "Paciente"),
    name: asString(row.name),
    birth_date: asNullableString(row.birth_date),
    address: asNullableString(row.address),
    care_level: asNullableString(row.care_level),
    condition_summary: asNullableString(row.condition_summary),
    family_user_id: asNullableString(row.family_user_id),
    status,
    notes: asNullableString(row.notes),
    created_at: asString(row.created_at),
  };
}

function mapAssignment(row: SupabaseRow): Assignment {
  return {
    id: assertUuid(asString(row.id), "Assignment"),
    patient_id: assertUuid(asString(row.patient_id), "Paciente do assignment"),
    caregiver_user_id: assertUuid(asString(row.caregiver_user_id), "Cuidador do assignment"),
    start_date: asString(row.start_date),
    end_date: asNullableString(row.end_date),
    active: asBoolean(row.active) ? 1 : 0,
    created_at: asString(row.created_at),
  };
}

function mapCaregiverScheduleEntry(
  row: SupabaseRow,
  assignment: Assignment,
): CaregiverScheduleEntry {
  return {
    id: assertUuid(asString(row.id), "Escala"),
    caregiver_assignment_id: assertUuid(asString(row.caregiver_assignment_id), "Vínculo da escala"),
    patient_id: assignment.patient_id,
    caregiver_user_id: assignment.caregiver_user_id,
    scheduled_date: asString(row.scheduled_date),
    start_time: normalizeTime(asString(row.start_time)) || "",
    end_time: normalizeTime(asString(row.end_time)) || "",
    ends_next_day: asBoolean(row.ends_next_day),
    profession: asProfession(row.profession),
    payroll_amount_override_cents:
      typeof row.payroll_amount_override_cents === "number" ? row.payroll_amount_override_cents : null,
    payroll_rate_status: row.payroll_rate_status === "gerado" ? "gerado" : "valor_pendente",
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
  };
}

function mapLead(row: SupabaseRow): Lead {
  return {
    id: assertUuid(asString(row.id), "Lead"),
    name: asString(row.name),
    email: asString(row.email),
    phone: asString(row.phone),
    patient_name: asNullableString(row.patient_name),
    care_type: asNullableString(row.care_type),
    message: asNullableString(row.message),
    status: asLeadStatus(row.status),
    created_at: asString(row.created_at),
  };
}

function mapProfessionalApplication(row: SupabaseRow): ProfessionalApplication {
  return {
    id: assertUuid(asString(row.id), "Candidatura"),
    name: asString(row.name),
    email: asString(row.email),
    phone: asString(row.phone),
    city: asNullableString(row.city),
    profession: asProfession(row.profession),
    coren: asNullableString(row.coren),
    experience: asNullableString(row.experience),
    availability_days: asStringArray(row.availability_days),
    availability_shifts: asStringArray(row.availability_shifts),
    available_from: asNullableString(row.available_from),
    notes: asNullableString(row.notes),
    status: asProfessionalStatus(row.status),
    lgpd_consent: asBoolean(row.lgpd_consent),
    lgpd_consent_at: asNullableString(row.lgpd_consent_at),
    privacy_notice_version: asNullableString(row.privacy_notice_version),
    reviewed_at: asNullableString(row.reviewed_at),
    reviewed_by: asNullableString(row.reviewed_by),
    created_at: asString(row.created_at),
  };
}

function mapCaregiverProfile(row: SupabaseRow, accessEmail?: string | null): CaregiverProfile {
  return {
    id: assertUuid(asString(row.id), "Perfil de cuidador"),
    application_id: asNullableString(row.application_id),
    user_id: asNullableString(row.user_id),
    name: asString(row.name),
    contact_email: asString(row.contact_email),
    access_email: accessEmail || null,
    phone: asString(row.phone),
    city: asNullableString(row.city),
    profession: asProfession(row.profession),
    coren: asNullableString(row.coren),
    experience: asNullableString(row.experience),
    availability_days: asStringArray(row.availability_days),
    availability_shifts: asStringArray(row.availability_shifts),
    available_from: asNullableString(row.available_from),
    notes: asNullableString(row.notes),
    account_status: asCaregiverStatus(row.account_status),
    approved_at: asString(row.approved_at),
    created_at: asString(row.created_at),
  };
}

function mapContract(row: SupabaseRow): ContractDocument {
  return {
    id: assertUuid(asString(row.id), "Contrato"),
    family_user_id: asNullableString(row.family_user_id),
    caregiver_profile_id: asNullableString(row.caregiver_profile_id),
    caregiver_user_id: asNullableString(row.caregiver_user_id),
    file_name: asString(row.file_name),
    mime_type: asString(row.mime_type),
    file_size: asNumber(row.file_size) || 0,
    uploaded_by: asNullableString(row.uploaded_by),
    created_at: asString(row.created_at),
  };
}

function mapDailyRecord(row: SupabaseRow): DailyRecord {
  return {
    id: assertUuid(asString(row.id), "Registro diário"),
    patient_id: assertUuid(asString(row.patient_id), "Paciente do registro"),
    caregiver_user_id: assertUuid(asString(row.caregiver_user_id), "Cuidador do registro"),
    record_date: asString(row.record_date),
    record_time: normalizeTime(row.record_time),
    bp_systolic: asNumber(row.bp_systolic),
    bp_diastolic: asNumber(row.bp_diastolic),
    heart_rate: asNumber(row.heart_rate),
    temperature: asNumber(row.temperature),
    spo2: asNumber(row.spo2),
    glucose: asNumber(row.glucose),
    medications: asNullableString(row.medications),
    feeding: asNullableString(row.feeding),
    hygiene: asNullableString(row.hygiene),
    mobility: asNullableString(row.mobility),
    mood: asNullableString(row.mood),
    pain_level: asNumber(row.pain_level),
    notes: asNullableString(row.notes),
    incident: asBoolean(row.incident) ? 1 : 0,
    incident_description: asNullableString(row.incident_description),
    // Hydrated asynchronously from Storage. This compatibility field never
    // represents bytes persisted in Postgres.
    photo_data: null,
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
  };
}

function mapAuditEvent(row: SupabaseRow): DailyRecordAuditEvent {
  if (row.action !== "created" && row.action !== "updated") {
    throw new SupabaseDataError("Auditoria Supabase contém uma ação inválida.");
  }
  return {
    id: assertUuid(asString(row.id), "Auditoria"),
    record_id: assertUuid(asString(row.record_id), "Registro da auditoria"),
    patient_id: assertUuid(asString(row.patient_id), "Paciente da auditoria"),
    actor_user_id: asNullableString(row.actor_user_id),
    actor_name: asString(row.actor_name),
    action: row.action,
    changed_fields: asStringArray(row.changed_fields),
    before_data: asJsonString(row.before_data),
    after_data: asJsonString(row.after_data),
    created_at: asString(row.created_at),
  };
}

function storageEnabled(): void {
  if (runtimeValue("VELLORA_STORAGE_PROVIDER")?.trim().toLowerCase() !== "supabase") {
    throw new SupabaseDataError(
      "VELLORA_DATA_PROVIDER=supabase exige VELLORA_STORAGE_PROVIDER=supabase antes de manipular arquivos.",
    );
  }
}

function photoExtension(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

function parsePhotoDataUri(value: string): { contentType: string; bytes: Uint8Array } {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  if (!match) {
    throw new SupabaseDataError(
      "Foto inválida para o provider Supabase; envie uma imagem ou deixe o campo vazio.",
    );
  }
  const bytes = new Uint8Array(Buffer.from(match[2], "base64"));
  if (bytes.length === 0) throw new SupabaseDataError("Foto vazia.");
  return { contentType: match[1], bytes };
}

async function uploadRecordPhoto(
  patientId: string,
  recordId: string,
  value: string | null,
): Promise<string | null> {
  if (!value) return null;
  storageEnabled();
  const parsed = parsePhotoDataUri(value);
  const key = `patients/${assertUuid(patientId, "Paciente")}/records/${assertUuid(recordId, "Registro")}/${randomUUID()}.${photoExtension(parsed.contentType)}`;
  await putStoredFile(key, parsed.bytes, parsed.contentType);
  return key;
}

function contentTypeFromStorageKey(key: string): string {
  if (/\.png$/i.test(key)) return "image/png";
  if (/\.webp$/i.test(key)) return "image/webp";
  return "image/jpeg";
}

async function hydratePhoto(record: DailyRecord, row: SupabaseRow): Promise<DailyRecord> {
  const key = asNullableString(row.photo_storage_key);
  if (!key) return record;
  storageEnabled();
  const bytes = await getStoredFile(key);
  if (!bytes) return record;
  return {
    ...record,
    photo_data: `data:${contentTypeFromStorageKey(key)};base64,${Buffer.from(bytes).toString("base64")}`,
  };
}

async function hydratePhotos(rows: SupabaseRow[]): Promise<DailyRecord[]> {
  return Promise.all(rows.map(async (row) => hydratePhoto(mapDailyRecord(row), row)));
}

type ProfileWithAuth = { profile: SupabaseRow; authUser: SupabaseAuthUser | null };

async function listAuthUsers(client: SupabaseClient): Promise<SupabaseAuthUser[]> {
  const users: SupabaseAuthUser[] = [];
  let page = 1;
  const perPage = 1_000;
  while (true) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    requireNoError("Não foi possível listar usuários Auth Supabase", error);
    const pageUsers = data?.users || [];
    users.push(...pageUsers);
    if (pageUsers.length < perPage) break;
    page += 1;
  }
  return users;
}

async function profilesWithAuth(ids?: string[]): Promise<ProfileWithAuth[]> {
  const client = serviceClient();
  let query = client.from("profiles").select("*");
  if (ids && ids.length > 0) query = query.in("id", ids.map((id) => assertUuid(id, "Perfil")));
  const { data, error } = await query;
  requireNoError("Não foi possível consultar perfis Supabase", error);
  const authUsers = await listAuthUsers(client);
  const authById = new Map(authUsers.map((user) => [user.id, user]));
  return ((data || []) as SupabaseRow[]).map((profile) => ({
    profile,
    authUser: authById.get(asString(profile.id)) || null,
  }));
}

async function profileWithAuth(id: string): Promise<ProfileWithAuth | undefined> {
  const rows = await profilesWithAuth([id]);
  return rows[0];
}

async function activeAuthUserByEmail(email: string): Promise<ProfileWithAuth | undefined> {
  const normalized = email.trim().toLowerCase();
  const rows = await profilesWithAuth();
  return rows.find(
    ({ profile, authUser }) =>
      asBoolean(profile.active) && authUser?.email?.trim().toLowerCase() === normalized,
  );
}

async function createAuthProfile(
  client: SupabaseClient,
  input: { name: string; email: string; password: string; role: User["role"]; phone?: string },
): Promise<User> {
  const email = input.email.trim().toLowerCase();
  if (!email || !input.password) throw new SupabaseDataError("E-mail e senha são obrigatórios.");
  const { data: authData, error: authError } = await client.auth.admin.createUser({
    email,
    password: input.password,
    email_confirm: true,
  });
  if (authError && isDuplicateAccountEmailError(authError)) {
    throw new SupabaseDataError(DUPLICATE_ACCOUNT_EMAIL_MESSAGE);
  }
  requireNoError("Não foi possível criar usuário no Supabase Auth", authError);
  if (!authData.user) throw new SupabaseDataError("Supabase Auth não retornou o usuário criado.");

  const { data: profile, error: profileError } = await client
    .from("profiles")
    .insert({
      id: authData.user.id,
      name: input.name,
      role: input.role,
      phone: input.phone?.trim() || null,
      active: true,
    })
    .select("*")
    .single();
  if (profileError || !profile) {
    await client.auth.admin.deleteUser(authData.user.id).catch(() => undefined);
    throw operationError("Não foi possível criar perfil de aplicação Supabase", profileError);
  }
  return mapProfile(profile as SupabaseRow, authData.user);
}

async function deactivateProfile(client: SupabaseClient, id: string, name: string): Promise<void> {
  const profileId = assertUuid(id, "Perfil");
  const { error } = await client
    .from("profiles")
    .update({ name, phone: null, active: false, updated_at: new Date().toISOString() })
    .eq("id", profileId);
  requireNoError("Não foi possível desativar perfil Supabase", error);

  // The profile is the authorization source. Rotating the Auth e-mail is a
  // compatibility measure that permits a future account to reuse the address;
  // old sessions remain unusable because the profile is inactive.
  const anonymizedEmail = `removido-${profileId}@anonimo.vellora.invalid`;
  const { error: authError } = await client.auth.admin.updateUserById(profileId, {
    email: anonymizedEmail,
    email_confirm: true,
  });
  if (authError) {
    console.error("[supabase-data] Perfil desativado, mas não foi possível anonimizar o e-mail Auth.", {
      error: authError.message,
    });
  }
}

async function contractKeys(
  client: SupabaseClient,
  column: "family_user_id" | "caregiver_profile_id" | "caregiver_user_id",
  id: string,
): Promise<string[]> {
  const { data, error } = await client
    .from("contract_documents")
    .select("storage_key")
    .eq(column, assertUuid(id, "Proprietário do contrato"));
  requireNoError("Não foi possível consultar arquivos de contrato", error);
  return ((data || []) as SupabaseRow[])
    .map((row) => asNullableString(row.storage_key))
    .filter((key): key is string => Boolean(key));
}

async function cleanupContracts(keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    storageEnabled();
    await deleteStoredFiles(keys);
  } catch (error) {
    console.error("[supabase-data] Metadados removidos, mas arquivos não puderam ser limpos.", {
      error: error instanceof Error ? error.message : "Erro desconhecido",
    });
  }
}

// ---------- Users ----------
export async function getUserByEmail(email: string): Promise<User | undefined> {
  const match = await activeAuthUserByEmail(email);
  return match ? mapProfile(match.profile, match.authUser) : undefined;
}

export async function findUserByEmailIncludingInactive(email: string): Promise<User | undefined> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;
  const rows = await profilesWithAuth();
  const match = rows.find(
    ({ authUser }) => authUser?.email?.trim().toLowerCase() === normalized,
  );
  return match ? mapProfile(match.profile, match.authUser) : undefined;
}

export async function getUserById(id: string): Promise<User | undefined> {
  const match = await profileWithAuth(assertUuid(id, "Usuário"));
  return match ? mapProfile(match.profile, match.authUser) : undefined;
}

export async function getUsersByIds(ids: string[]): Promise<User[]> {
  if (!ids.length) return [];
  const uniqueIds = [...new Set(ids.map((id) => assertUuid(id, "Usuário")))];
  const rows = await profilesWithAuth(uniqueIds);
  const byId = new Map(rows.map((row) => [asString(row.profile.id), row]));
  return uniqueIds
    .map((id) => byId.get(id))
    .filter((row): row is ProfileWithAuth => Boolean(row))
    .map((row) => mapProfile(row.profile, row.authUser));
}

export async function listUsersByRole(role: string, includeInactive = false): Promise<User[]> {
  const normalizedRole = asRole(role.trim().toLowerCase());
  const client = serviceClient();
  const { data: membershipRows, error: membershipError } = await client
    .from("profile_role_memberships")
    .select("profile_id, active")
    .eq("role", normalizedRole);
  requireNoError("Não foi possível consultar vínculos de perfil", membershipError);
  const membershipById = new Map(
    ((membershipRows || []) as SupabaseRow[]).map((row) => [
      asString(row.profile_id),
      asBoolean(row.active),
    ]),
  );
  const rows = (await profilesWithAuth()).filter(({ profile }) => {
    const id = asString(profile.id);
    return membershipById.has(id)
      && (includeInactive || (asBoolean(profile.active) && membershipById.get(id) === true));
  });
  return rows
    .sort((a, b) => asString(a.profile.name).localeCompare(asString(b.profile.name)))
    .map((row) => ({
      ...mapProfile(row.profile, row.authUser),
      membership_active: membershipById.get(asString(row.profile.id)) === true,
    }));
}

export async function listUserRoles(id: string): Promise<User["role"][]> {
  const client = serviceClient();
  const { data, error } = await client
    .from("profile_role_memberships")
    .select("role")
    .eq("profile_id", assertUuid(id, "Perfil"))
    .eq("active", true)
    .order("is_default", { ascending: false })
    .order("role", { ascending: true });
  requireNoError("Não foi possível consultar os perfis de acesso", error);
  return ((data || []) as SupabaseRow[]).map((row) => asRole(row.role));
}

export async function grantCoordinatorRole(id: string, grantedBy: string): Promise<void> {
  const client = serviceClient();
  const profileId = assertUuid(id, "Perfil");
  const actorId = assertUuid(grantedBy, "Administrador");
  const target = await profileWithAuth(profileId);
  if (!target) throw new SupabaseDataError("Conta não encontrada.");
  if (!asBoolean(target.profile.active)) {
    throw new SupabaseDataError("A conta está inativa. Reative a conta antes de adicionar outro acesso.");
  }
  const { data: existingMemberships, error: membershipsError } = await client
    .from("profile_role_memberships")
    .select("role")
    .eq("profile_id", profileId);
  requireNoError("Não foi possível validar os perfis da conta", membershipsError);
  const hasAdminRole = asString(target.profile.role) === "admin"
    || ((existingMemberships || []) as SupabaseRow[]).some((row) => row.role === "admin");
  if (hasAdminRole) {
    throw new SupabaseDataError("O acesso de administrador não pode ser combinado com outros perfis.");
  }
  const { error } = await client
    .from("profile_role_memberships")
    .upsert({
      profile_id: profileId,
      role: "coordenador_operacional",
      active: true,
      is_default: false,
      granted_by: actorId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "profile_id,role" });
  requireNoError("Não foi possível adicionar o acesso de coordenação", error);
}

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
  role: User["role"];
  phone?: string;
}): Promise<User> {
  return createAuthProfile(serviceClient(), input);
}

export async function setCoordinatorAccountActive(id: string, active: boolean): Promise<void> {
  const client = serviceClient();
  const profileId = assertUuid(id, "Conta operacional");
  if (active) {
    const target = await profileWithAuth(profileId);
    if (!target || !asBoolean(target.profile.active)) {
      throw new SupabaseDataError("A conta está inativa globalmente. Reative a conta antes de reativar este perfil.");
    }
  }
  const { data, error } = await client
    .from("profile_role_memberships")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("profile_id", profileId)
    .eq("role", "coordenador_operacional")
    .select("profile_id")
    .maybeSingle();
  requireNoError("Não foi possível atualizar acesso da coordenação", error);
  if (!data) throw new SupabaseDataError("Conta de coordenação operacional não encontrada.");
}

export async function createManualCaregiver(input: {
  name: string;
  email: string;
  password: string;
  phone?: string;
  profession: CaregiverProfile["profession"];
}): Promise<User> {
  const client = serviceClient();
  const user = await createAuthProfile(client, {
    name: input.name,
    email: input.email,
    password: input.password,
    role: "cuidador",
    phone: input.phone,
  });
  const { error } = await client.from("caregiver_profiles").insert({
    id: randomUUID(),
    application_id: null,
    user_id: user.id,
    name: input.name.trim(),
    contact_email: input.email.trim().toLowerCase(),
    phone: input.phone?.trim() || "",
    profession: input.profession,
    availability_days: [],
    availability_shifts: [],
    account_status: "ativo",
    approved_at: new Date().toISOString(),
  });
  if (error) {
    await client.from("profiles").delete().eq("id", user.id);
    await client.auth.admin.deleteUser(user.id).catch(() => undefined);
    throw operationError("Não foi possível criar perfil profissional Supabase", error);
  }
  return user;
}

export async function updateFamilyUser(id: string, fields: FamilyUserUpdate): Promise<void> {
  const client = await requestClient();
  const userId = assertUuid(id, "Família");
  const update: SupabaseRow = {};
  if ("name" in fields) update.name = fields.name;
  if ("phone" in fields) update.phone = fields.phone ?? null;
  if (!Object.keys(update).length) return;
  const { error } = await client
    .from("profiles")
    .update(update)
    .eq("id", userId)
    .eq("role", "familia")
    .eq("active", true);
  requireNoError("Não foi possível atualizar cadastro da família Supabase", error);
}

// ---------- Patients ----------
export async function getActivePatientCount(): Promise<number> {
  const client = await requestClient();
  const { count, error } = await client
    .from("patients")
    .select("*", { count: "exact", head: true })
    .eq("status", "ativo");
  requireNoError("Não foi possível contar pacientes ativos Supabase", error);
  return count || 0;
}

export async function listPatients(): Promise<Patient[]> {
  const client = await requestClient();
  const { data, error } = await client.from("patients").select("*").order("created_at", { ascending: false });
  requireNoError("Não foi possível listar pacientes Supabase", error);
  return ((data || []) as SupabaseRow[]).map(mapPatient);
}

export async function getPatient(id: string): Promise<Patient | undefined> {
  const client = await requestClient();
  const { data, error } = await client.from("patients").select("*").eq("id", assertUuid(id, "Paciente")).maybeSingle();
  requireNoError("Não foi possível consultar paciente Supabase", error);
  return data ? mapPatient(data as SupabaseRow) : undefined;
}

export async function getPatientForPortal(id: string): Promise<Patient | undefined> {
  const client = await requestClient();
  const { data, error } = await client
    .from("patients")
    .select(PORTAL_PATIENT_COLUMNS)
    .eq("id", assertUuid(id, "Paciente"))
    .maybeSingle();
  requireNoError("Não foi possível consultar paciente do portal Supabase", error);
  return data ? mapPatient(data as SupabaseRow) : undefined;
}

export async function listPatientsByFamily(familyUserId: string): Promise<Patient[]> {
  const client = await requestClient();
  const { data, error } = await client
    .from("patients")
    .select(PORTAL_PATIENT_COLUMNS)
    .eq("family_user_id", assertUuid(familyUserId, "Família"))
    .order("created_at", { ascending: false });
  requireNoError("Não foi possível listar pacientes da família", error);
  return ((data || []) as SupabaseRow[]).map(mapPatient);
}

function mapFamilyPatientServiceRate(row: SupabaseRow): FamilyPatientServiceRate {
  return {
    id: assertUuid(asString(row.id), "Valor de serviço"),
    family_user_id: assertUuid(asString(row.family_user_id), "Família"),
    patient_id: assertUuid(asString(row.patient_id), "Paciente"),
    profession: asProfession(row.profession),
    amount_cents: asNumber(row.amount_cents) ?? 0,
    valid_from: asString(row.valid_from),
    valid_to: asNullableString(row.valid_to),
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
  };
}

export async function listFamilyPatientServiceRates(familyUserId: string): Promise<FamilyPatientServiceRate[]> {
  const client = await requestClient();
  const { data, error } = await client
    .from("family_patient_service_rates")
    .select("*")
    .eq("family_user_id", assertUuid(familyUserId, "Família"))
    .order("patient_id")
    .order("profession")
    .order("valid_from", { ascending: false });
  requireNoError("Não foi possível listar os valores dos serviços da família", error);
  return ((data || []) as SupabaseRow[]).map(mapFamilyPatientServiceRate);
}

export async function listFamilyContractedServices(familyUserId: string): Promise<FamilyContractedService[]> {
  const client = await requestClient();
  const { data, error } = await client.rpc("list_family_contracted_services", {
    p_family_user_id: assertUuid(familyUserId, "Família"),
  });
  requireNoError("Não foi possível listar os serviços contratados da família", error);
  return ((data || []) as SupabaseRow[]).map((row) => ({
    patient_id: assertUuid(asString(row.patient_id), "Paciente"),
    profession: asProfession(row.profession),
  }));
}

export async function saveFamilyPatientServiceRates(input: FamilyPatientServiceRateInput): Promise<void> {
  const client = await requestClient();
  const { error } = await client.rpc("save_family_patient_service_rates", {
    p_family_user_id: assertUuid(input.family_user_id, "Família"),
    p_patient_id: assertUuid(input.patient_id, "Paciente"),
    p_effective_from: input.effective_from,
    p_rates: input.rates,
  });
  requireNoError("Não foi possível salvar os valores dos serviços da família", error);
}

export async function listPatientsByCaregiver(caregiverUserId: string): Promise<Patient[]> {
  const client = await requestClient();
  const caregiverId = assertUuid(caregiverUserId, "Cuidador");
  const { data: assignments, error: assignmentError } = await client
    .from("caregiver_assignments")
    .select("patient_id")
    .eq("caregiver_user_id", caregiverId)
    .eq("active", true);
  requireNoError("Não foi possível consultar assignments do cuidador", assignmentError);
  const patientIds = ((assignments || []) as SupabaseRow[])
    .map((row) => asNullableString(row.patient_id))
    .filter((id): id is string => Boolean(id));
  if (!patientIds.length) return [];
  const { data, error } = await client.from("patients").select(PORTAL_PATIENT_COLUMNS).in("id", patientIds).order("name");
  requireNoError("Não foi possível listar pacientes do cuidador", error);
  return ((data || []) as SupabaseRow[]).map(mapPatient);
}

export async function createPatient(input: {
  name: string;
  birth_date?: string;
  address?: string;
  care_level?: string;
  condition_summary?: string;
  family_user_id?: string | null;
  status?: Patient["status"];
  notes?: string;
}): Promise<Patient> {
  const client = await requestClient();
  const row = {
    id: randomUUID(),
    name: input.name,
    birth_date: input.birth_date || null,
    address: input.address || null,
    care_level: input.care_level || null,
    condition_summary: input.condition_summary || null,
    family_user_id: input.family_user_id ? assertUuid(input.family_user_id, "Família") : null,
    status: input.status || "pendente",
    notes: input.notes || null,
  };
  const { data, error } = await client.from("patients").insert(row).select("*").single();
  return mapPatient(requireValue("Não foi possível criar paciente Supabase", data as SupabaseRow | null, error));
}

export async function updatePatient(id: string, fields: Partial<Patient>): Promise<void> {
  const client = await requestClient();
  const allowed = [
    "name",
    "birth_date",
    "address",
    "care_level",
    "condition_summary",
    "family_user_id",
    "status",
    "notes",
  ] as const;
  const update: SupabaseRow = {};
  for (const key of allowed) {
    if (key in fields) {
      update[key] = key === "family_user_id" && fields[key]
        ? assertUuid(fields[key] as string, "Família")
        : fields[key] ?? null;
    }
  }
  if (!Object.keys(update).length) return;
  const { error } = await client.from("patients").update(update).eq("id", assertUuid(id, "Paciente"));
  requireNoError("Não foi possível atualizar paciente Supabase", error);
}

export async function deletePatient(id: string): Promise<void> {
  const client = await requestClient();
  const patientId = assertUuid(id, "Paciente");
  await assertNoScheduleHistory(client, "patient_id", patientId);
  const { error } = await client.from("patients").delete().eq("id", patientId);
  requireNoError("Não foi possível excluir paciente Supabase", error);
}

async function assertNoScheduleHistory(
  client: SupabaseClient,
  assignmentField: "patient_id" | "caregiver_user_id",
  targetId: string,
): Promise<void> {
  const { data: assignments, error: assignmentError } = await client
    .from("caregiver_assignments")
    .select("id")
    .eq(assignmentField, targetId);
  requireNoError("Não foi possível verificar o histórico de escalas Supabase", assignmentError);
  const assignmentIds = ((assignments || []) as SupabaseRow[])
    .map((assignment) => asString(assignment.id))
    .filter(Boolean);
  if (!assignmentIds.length) return;

  const { data: scheduledEntries, error: scheduleError } = await client
    .from("caregiver_schedule_entries")
    .select("id")
    .in("caregiver_assignment_id", assignmentIds)
    .limit(1);
  requireNoError("Não foi possível verificar o histórico de escalas Supabase", scheduleError);
  if (scheduledEntries?.length) throw new ScheduleHistoryConflictError();
}

// ---------- Assignments ----------
export async function listAssignmentsForPatient(patientId: string): Promise<Assignment[]> {
  const client = await requestClient();
  const { data, error } = await client
    .from("caregiver_assignments")
    .select("*")
    .eq("patient_id", assertUuid(patientId, "Paciente"))
    .order("active", { ascending: false })
    .order("start_date", { ascending: false });
  requireNoError("Não foi possível listar assignments Supabase", error);
  return ((data || []) as SupabaseRow[]).map(mapAssignment);
}

export async function createAssignment(input: {
  patient_id: string;
  caregiver_user_id: string;
  start_date: string;
}): Promise<Assignment> {
  const client = await requestClient();
  const patientId = assertUuid(input.patient_id, "Paciente");
  const caregiverUserId = assertUuid(input.caregiver_user_id, "Cuidador");

  const { data: inactiveData, error: inactiveError } = await client
    .from("caregiver_assignments")
    .select("*")
    .eq("patient_id", patientId)
    .eq("caregiver_user_id", caregiverUserId)
    .eq("start_date", input.start_date)
    .eq("active", false)
    .order("created_at", { ascending: false })
    .limit(2);
  requireNoError("Não foi possível verificar vínculo histórico Supabase", inactiveError);

  const inactiveRows = (inactiveData || []) as SupabaseRow[];
  if (inactiveRows.length > 1) {
    throw new AssignmentConflictError("duplicate_history", ASSIGNMENT_HISTORY_CONFLICT_MESSAGE);
  }

  const { data: activeData, error: activeError } = await client
    .from("caregiver_assignments")
    .select("*")
    .eq("patient_id", patientId)
    .eq("caregiver_user_id", caregiverUserId)
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  requireNoError("Não foi possível verificar vínculo ativo Supabase", activeError);
  if (activeData) {
    throw new AssignmentConflictError("active_duplicate", ASSIGNMENT_ACTIVE_CONFLICT_MESSAGE);
  }

  const inactiveAssignment = inactiveRows[0];
  if (inactiveAssignment) {
    const assignmentId = assertUuid(asString(inactiveAssignment.id), "Assignment");
    const { data: restoredData, error: restoredError } = await client
      .from("caregiver_assignments")
      .update({ active: true, end_date: null, updated_at: new Date().toISOString() })
      .eq("id", assignmentId)
      .eq("active", false)
      .select("*")
      .maybeSingle();
    if (restoredError) {
      if (isAssignmentUniqueViolation(restoredError)) {
        throw new AssignmentConflictError("duplicate_assignment", ASSIGNMENT_DUPLICATE_CONFLICT_MESSAGE);
      }
      throw operationError("Não foi possível reativar assignment Supabase", restoredError);
    }
    if (restoredData) return mapAssignment(restoredData as SupabaseRow);

    const { data: activeAfterRace, error: activeAfterRaceError } = await client
      .from("caregiver_assignments")
      .select("id")
      .eq("patient_id", patientId)
      .eq("caregiver_user_id", caregiverUserId)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    requireNoError("Não foi possível confirmar a reativação Supabase", activeAfterRaceError);
    if (activeAfterRace) {
      throw new AssignmentConflictError("active_duplicate", ASSIGNMENT_ACTIVE_CONFLICT_MESSAGE);
    }
    throw new SupabaseDataError("Não foi possível reativar assignment Supabase.");
  }

  const { data, error } = await client
    .from("caregiver_assignments")
    .insert({
      id: randomUUID(),
      patient_id: patientId,
      caregiver_user_id: caregiverUserId,
      start_date: input.start_date,
      active: true,
    })
    .select("*")
    .single();
  if (isAssignmentUniqueViolation(error)) {
    throw new AssignmentConflictError("duplicate_assignment", ASSIGNMENT_DUPLICATE_CONFLICT_MESSAGE);
  }
  return mapAssignment(requireValue("Não foi possível criar assignment Supabase", data as SupabaseRow | null, error));
}

export async function deactivateAssignment(id: string): Promise<void> {
  const client = await requestClient();
  const { error } = await client
    .from("caregiver_assignments")
    .update({ active: false, end_date: new Date().toISOString().slice(0, 10) })
    .eq("id", assertUuid(id, "Assignment"));
  requireNoError("Não foi possível desativar assignment Supabase", error);
}

export async function isCaregiverAssignedToPatient(caregiverUserId: string, patientId: string): Promise<boolean> {
  const client = await requestClient();
  const { data, error } = await client
    .from("caregiver_assignments")
    .select("id")
    .eq("caregiver_user_id", assertUuid(caregiverUserId, "Cuidador"))
    .eq("patient_id", assertUuid(patientId, "Paciente"))
    .eq("active", true)
    .limit(1);
  requireNoError("Não foi possível verificar assignment Supabase", error);
  return ((data || []) as SupabaseRow[]).length > 0;
}

// ---------- Caregiver schedules ----------
const SCHEDULE_SAFE_COLUMNS = "id, caregiver_assignment_id, scheduled_date, start_time, end_time, ends_next_day, profession, created_by, updated_by, created_at, updated_at";

async function includeSchedulePayrollDetails(
  client: SupabaseClient,
  rows: SupabaseRow[],
): Promise<SupabaseRow[]> {
  if (!rows.length) return rows;
  const { data: authData, error: authError } = await client.auth.getUser();
  requireNoError("Não foi possível validar o acesso à escala", authError);
  if (!authData.user) return rows;
  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("role")
    .eq("id", authData.user.id)
    .maybeSingle();
  requireNoError("Não foi possível validar o perfil de acesso à escala", profileError);
  if (profile?.role !== "admin") return rows;

  const { data, error } = await client.rpc("get_schedule_payroll_details", {
    p_schedule_entry_ids: rows.map((row) => assertUuid(asString(row.id), "Escala")),
  });
  requireNoError("Não foi possível consultar os valores de pagamento da escala", error);
  const payrollById = new Map(((data || []) as SupabaseRow[]).map((row) => [asString(row.schedule_entry_id), row]));
  return rows.map((row) => {
    const payroll = payrollById.get(asString(row.id));
    return payroll ? {
      ...row,
      payroll_amount_override_cents: payroll.payroll_amount_override_cents,
      payroll_rate_status: payroll.payroll_rate_status,
    } : row;
  });
}

async function scheduleRowsForAssignments(
  assignments: Assignment[],
  startDate: string,
  endDateExclusive: string,
): Promise<CaregiverScheduleEntry[]> {
  if (!assignments.length) return [];
  const client = await requestClient();
  const assignmentById = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  const { data, error } = await client
    .from("caregiver_schedule_entries")
    .select(SCHEDULE_SAFE_COLUMNS)
    .in("caregiver_assignment_id", assignments.map((assignment) => assignment.id))
    .gte("scheduled_date", startDate)
    .lt("scheduled_date", endDateExclusive)
    .order("scheduled_date")
    .order("start_time");
  requireNoError("Não foi possível consultar escalas Supabase", error);
  const rows = await includeSchedulePayrollDetails(client, (data || []) as SupabaseRow[]);
  return rows.flatMap((row) => {
    const assignmentId = asString(row.caregiver_assignment_id);
    const assignment = assignmentById.get(assignmentId);
    return assignment ? [mapCaregiverScheduleEntry(row, assignment)] : [];
  });
}

export async function listCaregiverScheduleEntriesForPatient(
  patientId: string,
  startDate: string,
  endDateExclusive: string,
): Promise<CaregiverScheduleEntry[]> {
  const assignments = await listAssignmentsForPatient(assertUuid(patientId, "Paciente"));
  return scheduleRowsForAssignments(assignments, startDate, endDateExclusive);
}

export async function listCaregiverScheduleEntriesForCaregiver(
  caregiverUserId: string,
  startDate: string,
  endDateExclusive: string,
): Promise<CaregiverScheduleEntry[]> {
  const client = await requestClient();
  const userId = assertUuid(caregiverUserId, "Profissional");
  const { data, error } = await client
    .from("caregiver_assignments")
    .select("*")
    .eq("caregiver_user_id", userId)
    .eq("active", true);
  requireNoError("Não foi possível consultar vínculos do profissional Supabase", error);
  return scheduleRowsForAssignments(((data || []) as SupabaseRow[]).map(mapAssignment), startDate, endDateExclusive);
}

export async function listCaregiverScheduleEntriesForProfessional(
  caregiverUserId: string,
  startDate: string,
  endDateExclusive: string,
): Promise<CaregiverScheduleEntry[]> {
  const client = await requestClient();
  const { data, error } = await client
    .from("caregiver_assignments")
    .select("*")
    .eq("caregiver_user_id", assertUuid(caregiverUserId, "Profissional"));
  requireNoError("Não foi possível consultar vínculos do profissional Supabase", error);
  return scheduleRowsForAssignments(((data || []) as SupabaseRow[]).map(mapAssignment), startDate, endDateExclusive);
}

export async function getCaregiverScheduleEntry(id: string): Promise<CaregiverScheduleEntry | undefined> {
  const client = await requestClient();
  const scheduleId = assertUuid(id, "Escala");
  const { data, error } = await client
    .from("caregiver_schedule_entries")
    .select(SCHEDULE_SAFE_COLUMNS)
    .eq("id", scheduleId)
    .maybeSingle();
  requireNoError("Não foi possível consultar escala Supabase", error);
  if (!data) return undefined;

  const [row] = await includeSchedulePayrollDetails(client, [data as SupabaseRow]);
  const assignmentId = assertUuid(asString(row.caregiver_assignment_id), "Vínculo da escala");
  const { data: assignmentData, error: assignmentError } = await client
    .from("caregiver_assignments")
    .select("*")
    .eq("id", assignmentId)
    .maybeSingle();
  requireNoError("Não foi possível consultar vínculo da escala Supabase", assignmentError);
  return assignmentData
    ? mapCaregiverScheduleEntry(row, mapAssignment(assignmentData as SupabaseRow))
    : undefined;
}

export async function createCaregiverScheduleEntry(
  input: CaregiverScheduleEntryInput,
  actorUserId: string,
): Promise<CaregiverScheduleEntry> {
  const client = await requestClient();
  const insertValues: SupabaseRow = {
    caregiver_assignment_id: assertUuid(input.caregiver_assignment_id, "Vínculo da escala"),
    scheduled_date: input.scheduled_date,
    start_time: input.start_time,
    end_time: input.end_time,
    ends_next_day: input.ends_next_day,
    profession: input.profession,
    created_by: assertUuid(actorUserId, "Administrador"),
    updated_by: assertUuid(actorUserId, "Administrador"),
  };
  const { data, error } = await client
    .from("caregiver_schedule_entries")
    .insert(insertValues)
    .select("id")
    .single();
  const created = requireValue("Não foi possível criar escala Supabase", data as SupabaseRow | null, error);
  if (input.payroll_amount_override_cents !== undefined) {
    const { error: payrollError } = await client.rpc("set_schedule_payroll_override", {
      p_schedule_entry_id: assertUuid(asString(created.id), "Escala"),
      p_amount_cents: input.payroll_amount_override_cents,
    });
    requireNoError("Não foi possível salvar o valor excepcional do plantão", payrollError);
  }
  const schedule = await getCaregiverScheduleEntry(asString(created.id));
  if (!schedule) throw new SupabaseDataError("Não foi possível confirmar a escala criada.");
  return schedule;
}

export async function createCaregiverScheduleEntries(
  inputs: CaregiverScheduleEntryInput[],
  actorUserId: string,
): Promise<number> {
  if (inputs.length === 0 || inputs.length > 366) {
    throw new Error("A recorrência deve conter entre 1 e 366 plantões.");
  }
  const client = await requestClient();
  const rows = inputs.map((input) => ({
    id: randomUUID(),
    caregiver_assignment_id: assertUuid(input.caregiver_assignment_id, "Vínculo da escala"),
    scheduled_date: input.scheduled_date,
    start_time: input.start_time,
    end_time: input.end_time,
    ends_next_day: input.ends_next_day,
    profession: input.profession,
    created_by: assertUuid(actorUserId, "Administrador"),
    updated_by: assertUuid(actorUserId, "Administrador"),
  }));
  const { error } = await client.from("caregiver_schedule_entries").insert(rows);
  requireNoError("Não foi possível criar escalas recorrentes Supabase", error);
  return rows.length;
}

export async function updateCaregiverScheduleEntry(
  id: string,
  input: CaregiverScheduleEntryInput,
  actorUserId: string,
): Promise<void> {
  const client = await requestClient();
  const { error } = await client
    .from("caregiver_schedule_entries")
    .update({
      caregiver_assignment_id: assertUuid(input.caregiver_assignment_id, "Vínculo da escala"),
      scheduled_date: input.scheduled_date,
      start_time: input.start_time,
      end_time: input.end_time,
      ends_next_day: input.ends_next_day,
      profession: input.profession,
      updated_by: assertUuid(actorUserId, "Administrador"),
      updated_at: new Date().toISOString(),
    })
    .eq("id", assertUuid(id, "Escala"));
  requireNoError("Não foi possível atualizar escala Supabase", error);
  if (input.payroll_amount_override_cents !== undefined) {
    const { error: payrollError } = await client.rpc("set_schedule_payroll_override", {
      p_schedule_entry_id: assertUuid(id, "Escala"),
      p_amount_cents: input.payroll_amount_override_cents,
    });
    requireNoError("Não foi possível atualizar o valor excepcional do plantão", payrollError);
  }
}

export async function deleteCaregiverScheduleEntry(id: string): Promise<void> {
  const client = await requestClient();
  const { error } = await client
    .from("caregiver_schedule_entries")
    .delete()
    .eq("id", assertUuid(id, "Escala"));
  requireNoError("Não foi possível remover escala Supabase", error);
}

// ---------- Leads ----------
export async function listLeads(): Promise<Lead[]> {
  const client = await requestClient();
  const { data, error } = await client.from("leads").select("*").order("created_at", { ascending: false });
  requireNoError("Não foi possível listar leads Supabase", error);
  return ((data || []) as SupabaseRow[]).map(mapLead);
}

export async function createLead(input: {
  name: string;
  email: string;
  phone: string;
  patient_name?: string;
  care_type?: string;
  message?: string;
}): Promise<Lead> {
  const client = serviceClient();
  const { data, error } = await client
    .from("leads")
    .insert({
      id: randomUUID(),
      name: input.name,
      email: input.email.trim().toLowerCase(),
      phone: input.phone,
      patient_name: input.patient_name || null,
      care_type: input.care_type || null,
      message: input.message || null,
      status: "novo",
    })
    .select("*")
    .single();
  return mapLead(requireValue("Não foi possível criar lead Supabase", data as SupabaseRow | null, error));
}

export async function updateLeadStatus(id: string, status: Lead["status"]): Promise<void> {
  const client = await requestClient();
  const { error } = await client
    .from("leads")
    .update({ status })
    .eq("id", assertUuid(id, "Lead"));
  requireNoError("Não foi possível atualizar status do lead Supabase", error);
}

export async function deleteLead(id: string): Promise<void> {
  const client = await requestClient();
  const { error } = await client.from("leads").delete().eq("id", assertUuid(id, "Lead"));
  requireNoError("Não foi possível excluir lead Supabase", error);
}

// ---------- Professional applications ----------
export async function listProfessionalApplications(): Promise<ProfessionalApplication[]> {
  const client = await requestClient();
  const { data, error } = await client
    .from("professional_applications")
    .select("*")
    .order("created_at", { ascending: false });
  requireNoError("Não foi possível listar candidaturas Supabase", error);
  return ((data || []) as SupabaseRow[]).map(mapProfessionalApplication);
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
  const client = serviceClient();
  const { data, error } = await client
    .from("professional_applications")
    .insert({
      id: randomUUID(),
      name: input.name,
      email: input.email.trim().toLowerCase(),
      phone: input.phone,
      city: input.city || null,
      profession: input.profession,
      coren: input.coren || null,
      experience: input.experience || null,
      availability_days: input.availability_days,
      availability_shifts: input.availability_shifts,
      available_from: input.available_from || null,
      notes: input.notes || null,
      status: "novo",
      lgpd_consent: input.lgpd_consent,
      lgpd_consent_at: new Date().toISOString(),
      privacy_notice_version: input.privacy_notice_version,
    })
    .select("*")
    .single();
  return mapProfessionalApplication(
    requireValue("Não foi possível criar candidatura Supabase", data as SupabaseRow | null, error),
  );
}

export async function updateProfessionalApplicationStatus(
  id: string,
  status: ProfessionalApplication["status"],
  reviewedBy: string,
): Promise<void> {
  const client = await requestClient();
  const applicationId = assertUuid(id, "Candidatura");
  const reviewerId = assertUuid(reviewedBy, "Revisor");
  if (status === "aprovado") {
    const { data: application, error: applicationError } = await client
      .from("professional_applications")
      .select("*")
      .eq("id", applicationId)
      .maybeSingle();
    const app = requireValue(
      "Não foi possível consultar candidatura Supabase",
      application as SupabaseRow | null,
      applicationError,
    );
    const { error: updateError } = await client
      .from("professional_applications")
      .update({ status, reviewed_at: new Date().toISOString(), reviewed_by: reviewerId })
      .eq("id", applicationId);
    requireNoError("Não foi possível aprovar candidatura Supabase", updateError);

    const { data: existing, error: existingError } = await client
      .from("caregiver_profiles")
      .select("*")
      .eq("application_id", applicationId)
      .maybeSingle();
    requireNoError("Não foi possível consultar perfil profissional Supabase", existingError);
    const existingRow = existing as SupabaseRow | null;
    const caregiverRow = {
      id: asString(existingRow?.id) || randomUUID(),
      application_id: applicationId,
      name: asString(app.name),
      contact_email: asString(app.email),
      phone: asString(app.phone),
      city: asNullableString(app.city),
      profession: asProfession(app.profession),
      coren: asNullableString(app.coren),
      experience: asNullableString(app.experience),
      availability_days: asStringArray(app.availability_days),
      availability_shifts: asStringArray(app.availability_shifts),
      available_from: asNullableString(app.available_from),
      notes: asNullableString(app.notes),
      account_status: existingRow && asNullableString(existingRow.user_id)
        ? asCaregiverStatus(existingRow.account_status)
        : "aguardando_acesso",
      approved_at: asString(existingRow?.approved_at) || new Date().toISOString(),
    };
    const { error: profileError } = await client
      .from("caregiver_profiles")
      .upsert(caregiverRow, { onConflict: "application_id" });
    requireNoError("Não foi possível criar perfil profissional Supabase", profileError);
    return;
  }

  const { error } = await client
    .from("professional_applications")
    .update({ status, reviewed_at: new Date().toISOString(), reviewed_by: reviewerId })
    .eq("id", applicationId);
  requireNoError("Não foi possível atualizar candidatura Supabase", error);
  if (status === "recusado") {
    const { error: profileError } = await client
      .from("caregiver_profiles")
      .update({ account_status: "inativo" })
      .eq("application_id", applicationId);
    requireNoError("Não foi possível inativar perfil profissional Supabase", profileError);
  }
}

export async function deleteProfessionalApplication(id: string): Promise<void> {
  const client = await requestClient();
  const { error } = await client
    .from("professional_applications")
    .delete()
    .eq("id", assertUuid(id, "Candidatura"));
  requireNoError("Não foi possível excluir candidatura Supabase", error);
}

// ---------- Caregiver bank ----------
async function caregiverRows(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<CaregiverProfile[]> {
  const result = await query;
  requireNoError("Não foi possível consultar perfis de cuidadores Supabase", result.error);
  const rows = (result.data || []) as SupabaseRow[];
  const userIds = rows
    .map((row) => asNullableString(row.user_id))
    .filter((id): id is string => Boolean(id));
  const authRows = userIds.length ? await profilesWithAuth(userIds) : [];
  const emails = new Map(
    authRows.map(({ profile, authUser }) => [asString(profile.id), authUser?.email || null]),
  );
  return rows.map((row) => mapCaregiverProfile(row, emails.get(asString(row.user_id))));
}

export async function listCaregiverProfiles(): Promise<CaregiverProfile[]> {
  const client = await requestClient();
  return caregiverRows(client.from("caregiver_profiles").select("*").order("approved_at", { ascending: false }).order("name"));
}

export async function getCaregiverProfile(id: string): Promise<CaregiverProfile | undefined> {
  const client = await requestClient();
  const result = await client.from("caregiver_profiles").select("*").eq("id", assertUuid(id, "Perfil de cuidador")).maybeSingle();
  requireNoError("Não foi possível consultar perfil de cuidador Supabase", result.error);
  if (!result.data) return undefined;
  const row = result.data as SupabaseRow;
  const authRows = row.user_id ? await profilesWithAuth([asString(row.user_id)]) : [];
  return mapCaregiverProfile(row, authRows[0]?.authUser?.email || null);
}

export async function getCaregiverProfileByUserId(userId: string): Promise<CaregiverProfile | undefined> {
  const client = await requestClient();
  const result = await client
    .from("caregiver_profiles")
    .select("*")
    .eq("user_id", assertUuid(userId, "Cuidador"))
    .maybeSingle();
  requireNoError("Não foi possível consultar perfil do cuidador Supabase", result.error);
  if (!result.data) return undefined;
  const row = result.data as SupabaseRow;
  const authRows = row.user_id ? await profilesWithAuth([asString(row.user_id)]) : [];
  return mapCaregiverProfile(row, authRows[0]?.authUser?.email || null);
}

export async function updateCaregiverProfile(id: string, fields: CaregiverProfileUpdate): Promise<void> {
  const client = await requestClient();
  const profileId = assertUuid(id, "Perfil de cuidador");
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
  const update: SupabaseRow = {};
  for (const key of allowed) {
    if (key in fields) update[key] = fields[key] ?? null;
  }
  if (!Object.keys(update).length) return;
  const { error } = await client.from("caregiver_profiles").update(update).eq("id", profileId);
  requireNoError("Não foi possível atualizar perfil de cuidador Supabase", error);
}

export async function updateCaregiverUser(
  id: string,
  fields: CaregiverUserUpdate,
): Promise<CaregiverUserUpdateResult> {
  const client = await requestClient();
  const userId = assertUuid(id, "Cuidador");

  const { data: existingData, error: existingError } = await client
    .from("caregiver_profiles")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  requireNoError("Não foi possível consultar perfil do cuidador Supabase", existingError);
  const existingProfile = existingData as SupabaseRow | null;

  const { data: userData, error: userError } = await client
    .from("profiles")
    .select("name, phone")
    .eq("id", userId)
    .eq("role", "cuidador")
    .eq("active", true)
    .maybeSingle();
  requireNoError("Não foi possível consultar cadastro do cuidador Supabase", userError);
  const userProfile = userData as SupabaseRow | null;
  if (!userProfile) throw new SupabaseDataError("Cadastro manual de profissional não encontrado.");

  const update: SupabaseRow = {};
  if ("name" in fields) update.name = fields.name;
  if ("phone" in fields) update.phone = fields.phone ?? null;
  if (Object.keys(update).length) {
    const { error } = await client
      .from("profiles")
      .update(update)
      .eq("id", userId)
      .eq("role", "cuidador")
      .eq("active", true);
    requireNoError("Não foi possível atualizar cadastro manual Supabase", error);
  }

  const profileFields: (keyof CaregiverUserUpdate)[] = [
    "name",
    "phone",
    "profession",
    "availability_days",
    "availability_shifts",
    "available_from",
  ];
  const profileUpdate: SupabaseRow = {};
  for (const key of profileFields) {
    if (key in fields) profileUpdate[key] = key === "phone" ? fields.phone ?? "" : fields[key] ?? null;
  }

  async function updateProfile(profileId: string): Promise<void> {
    if (!Object.keys(profileUpdate).length) return;
    const { error } = await client.from("caregiver_profiles").update(profileUpdate).eq("id", profileId);
    requireNoError("Não foi possível atualizar perfil de cuidador Supabase", error);
  }

  if (existingProfile) {
    const profileId = assertUuid(asString(existingProfile.id), "Perfil de cuidador");
    await updateProfile(profileId);
    return { profileId };
  }

  const authClient = serviceClient();
  const { data: authData, error: authError } = await authClient.auth.admin.getUserById(userId);
  requireNoError("Não foi possível consultar e-mail de acesso Supabase", authError);
  const accessEmail = authData.user?.email?.trim().toLowerCase();
  if (!accessEmail) throw new SupabaseDataError("O cuidador não possui e-mail de acesso válido.");

  const profileInsert = {
    user_id: userId,
    name: "name" in fields ? fields.name! : asString(userProfile.name),
    contact_email: accessEmail,
    phone: "phone" in fields ? fields.phone ?? "" : asNullableString(userProfile.phone) || "",
    profession: fields.profession ?? "cuidador",
    availability_days: fields.availability_days ?? [],
    availability_shifts: fields.availability_shifts ?? [],
    available_from: fields.available_from ?? null,
    account_status: "ativo" as const,
    approved_at: new Date().toISOString(),
  };
  const { data: insertedData, error: insertError } = await client
    .from("caregiver_profiles")
    .insert(profileInsert)
    .select("id")
    .single();
  if (insertError) {
    if (!isUniqueViolation(insertError)) {
      throw operationError("Não foi possível criar perfil profissional Supabase", insertError);
    }
    const { data: concurrentData, error: concurrentError } = await client
      .from("caregiver_profiles")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    requireNoError("Não foi possível recuperar perfil profissional Supabase", concurrentError);
    const concurrentProfileId = assertUuid(asString((concurrentData as SupabaseRow | null)?.id), "Perfil de cuidador");
    await updateProfile(concurrentProfileId);
    return { profileId: concurrentProfileId };
  }

  const insertedProfile = requireValue(
    "Não foi possível criar perfil profissional Supabase",
    insertedData as SupabaseRow | null,
    null,
  );
  return { profileId: assertUuid(asString(insertedProfile.id), "Perfil de cuidador") };
}

export async function createCaregiverAccess(input: {
  profileId: string;
  email: string;
  password: string;
}): Promise<User> {
  const client = serviceClient();
  const profileId = assertUuid(input.profileId, "Perfil de cuidador");
  const { data: profile, error: profileError } = await client
    .from("caregiver_profiles")
    .select("*")
    .eq("id", profileId)
    .maybeSingle();
  requireNoError("Não foi possível consultar perfil de cuidador Supabase", profileError);
  const row = profile as SupabaseRow | null;
  if (!row || row.user_id || asString(row.account_status) !== "aguardando_acesso") {
    throw new SupabaseDataError("Perfil não encontrado ou acesso já criado.");
  }
  if (await activeAuthUserByEmail(input.email)) {
    throw new SupabaseDataError("Este e-mail já está vinculado a outra conta.");
  }
  const user = await createAuthProfile(client, {
    name: asString(row.name),
    email: input.email,
    password: input.password,
    role: "cuidador",
    phone: asNullableString(row.phone) || undefined,
  });
  const { error: updateError } = await client
    .from("caregiver_profiles")
    .update({ user_id: user.id, account_status: "ativo" })
    .eq("id", profileId)
    .is("user_id", null)
    .eq("account_status", "aguardando_acesso");
  if (updateError) {
    await client.auth.admin.deleteUser(user.id).catch(() => undefined);
    throw operationError("Não foi possível vincular acesso ao perfil Supabase", updateError);
  }
  return user;
}

export async function deleteCaregiverProfile(id: string): Promise<void> {
  const client = serviceClient();
  const profileId = assertUuid(id, "Perfil de cuidador");
  const { data: profile, error: profileError } = await client
    .from("caregiver_profiles")
    .select("*")
    .eq("id", profileId)
    .maybeSingle();
  requireNoError("Não foi possível consultar perfil de cuidador Supabase", profileError);
  if (!profile) return;
  const row = profile as SupabaseRow;
  const userId = asNullableString(row.user_id);
  if (userId) await assertNoScheduleHistory(client, "caregiver_user_id", userId);
  const keys = await contractKeys(client, "caregiver_profile_id", profileId);
  if (userId) keys.push(...(await contractKeys(client, "caregiver_user_id", userId)));
  const { error: contractError } = await client.from("contract_documents").delete().or(`caregiver_profile_id.eq.${profileId}${userId ? `,caregiver_user_id.eq.${userId}` : ""}`);
  requireNoError("Não foi possível excluir contratos do perfil Supabase", contractError);
  if (userId) {
    const { error: assignmentError } = await client.from("caregiver_assignments").delete().eq("caregiver_user_id", userId);
    requireNoError("Não foi possível excluir assignments do cuidador Supabase", assignmentError);
  }
  const { error: deleteError } = await client.from("caregiver_profiles").delete().eq("id", profileId);
  requireNoError("Não foi possível excluir perfil de cuidador Supabase", deleteError);
  if (userId) await deactivateProfile(client, userId, "Profissional removido");
  await cleanupContracts(keys);
}

export async function deleteCaregiverUser(id: string): Promise<void> {
  const client = serviceClient();
  const userId = assertUuid(id, "Cuidador");
  await assertNoScheduleHistory(client, "caregiver_user_id", userId);
  const keys = await contractKeys(client, "caregiver_user_id", userId);
  const { error: contractError } = await client.from("contract_documents").delete().eq("caregiver_user_id", userId);
  requireNoError("Não foi possível excluir contratos do cuidador Supabase", contractError);
  const { error: assignmentError } = await client.from("caregiver_assignments").delete().eq("caregiver_user_id", userId);
  requireNoError("Não foi possível excluir assignments do cuidador Supabase", assignmentError);
  const { error: caregiverError } = await client
    .from("caregiver_profiles")
    .update({ user_id: null, account_status: "inativo" })
    .eq("user_id", userId);
  requireNoError("Não foi possível desassociar perfil do cuidador Supabase", caregiverError);
  await deactivateProfile(client, userId, "Profissional removido");
  await cleanupContracts(keys);
}

export async function deleteFamilyUser(id: string): Promise<void> {
  const client = serviceClient();
  const userId = assertUuid(id, "Família");
  const keys = await contractKeys(client, "family_user_id", userId);
  const { error: patientError } = await client.from("patients").update({ family_user_id: null }).eq("family_user_id", userId);
  requireNoError("Não foi possível desvincular pacientes da família Supabase", patientError);
  const { error: contractError } = await client.from("contract_documents").delete().eq("family_user_id", userId);
  requireNoError("Não foi possível excluir contratos da família Supabase", contractError);
  await deactivateProfile(client, userId, "Conta de família removida");
  await cleanupContracts(keys);
}

// ---------- Contract documents ----------
function contractColumn(ownerType: ContractOwnerType): "family_user_id" | "caregiver_profile_id" | "caregiver_user_id" {
  if (ownerType === "family") return "family_user_id";
  if (ownerType === "caregiver_profile") return "caregiver_profile_id";
  return "caregiver_user_id";
}

export async function listContractDocuments(ownerType: ContractOwnerType, ownerId: string): Promise<ContractDocument[]> {
  const client = await requestClient();
  const column = contractColumn(ownerType);
  const { data, error } = await client
    .from("contract_documents")
    .select("id, family_user_id, caregiver_profile_id, caregiver_user_id, file_name, mime_type, file_size, uploaded_by, created_at")
    .eq(column, assertUuid(ownerId, "Proprietário do contrato"))
    .order("created_at", { ascending: false });
  requireNoError("Não foi possível listar contratos Supabase", error);
  return ((data || []) as SupabaseRow[]).map(mapContract);
}

export async function listContractDocumentsForCaregiver(userId: string): Promise<ContractDocument[]> {
  const client = await requestClient();
  const caregiverId = assertUuid(userId, "Cuidador");
  const { data: profiles, error: profileError } = await client
    .from("caregiver_profiles")
    .select("id")
    .eq("user_id", caregiverId);
  requireNoError("Não foi possível consultar perfis do cuidador Supabase", profileError);
  const profileIds = ((profiles || []) as SupabaseRow[])
    .map((row) => asNullableString(row.id))
    .filter((id): id is string => Boolean(id));
  const ownership = [`caregiver_user_id.eq.${caregiverId}`];
  if (profileIds.length) ownership.push(`caregiver_profile_id.in.(${profileIds.join(",")})`);
  const { data, error } = await client
    .from("contract_documents")
    .select("id, family_user_id, caregiver_profile_id, caregiver_user_id, file_name, mime_type, file_size, uploaded_by, created_at")
    .or(ownership.join(","))
    .order("created_at", { ascending: false });
  requireNoError("Não foi possível listar contratos do cuidador Supabase", error);
  return ((data || []) as SupabaseRow[]).map(mapContract);
}

export async function getContractDocument(id: string): Promise<ContractDocument | undefined> {
  const client = await requestClient();
  const { data, error } = await client
    .from("contract_documents")
    .select("id, family_user_id, caregiver_profile_id, caregiver_user_id, file_name, mime_type, file_size, uploaded_by, created_at")
    .eq("id", assertUuid(id, "Contrato"))
    .maybeSingle();
  requireNoError("Não foi possível consultar contrato Supabase", error);
  return data ? mapContract(data as SupabaseRow) : undefined;
}

export async function getContractFileData(id: string): Promise<Uint8Array | null> {
  const client = await requestClient();
  const { data, error } = await client
    .from("contract_documents")
    .select("storage_key")
    .eq("id", assertUuid(id, "Contrato"))
    .maybeSingle();
  requireNoError("Não foi possível consultar arquivo de contrato Supabase", error);
  const key = asNullableString((data as SupabaseRow | null)?.storage_key);
  if (!key) return null;
  storageEnabled();
  return getStoredFile(key);
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
  const client = await requestClient();
  storageEnabled();
  const id = randomUUID();
  const storageKey = `contracts/${id}.pdf`;
  const column = contractColumn(input.ownerType);
  const ownerId = assertUuid(input.ownerId, "Proprietário do contrato");
  const uploadedBy = assertUuid(input.uploadedBy, "Autor do upload");
  await putStoredFile(storageKey, input.fileData, input.mimeType);
  const { data, error } = await client
    .from("contract_documents")
    .insert({
      id,
      family_user_id: column === "family_user_id" ? ownerId : null,
      caregiver_profile_id: column === "caregiver_profile_id" ? ownerId : null,
      caregiver_user_id: column === "caregiver_user_id" ? ownerId : null,
      file_name: input.fileName,
      mime_type: input.mimeType,
      file_size: input.fileSize,
      storage_key: storageKey,
      uploaded_by: uploadedBy,
    })
    .select("id, family_user_id, caregiver_profile_id, caregiver_user_id, file_name, mime_type, file_size, uploaded_by, created_at")
    .single();
  if (error || !data) {
    await deleteStoredFile(storageKey).catch(() => undefined);
    throw operationError("Não foi possível criar metadados do contrato Supabase", error);
  }
  return mapContract(data as SupabaseRow);
}

export async function registerStoredContractDocument(
  input: StoredContractDocumentInput,
): Promise<ContractDocument> {
  const client = serviceClient();
  const contractId = assertUuid(input.id, "Contrato");
  const ownerId = assertUuid(input.ownerId, "Proprietário do contrato");
  const uploadedBy = assertUuid(input.uploadedBy, "Autor do upload");
  const column = contractColumn(input.ownerType);
  const expectedStorageKey = `contracts/${contractId}.pdf`;
  if (input.storageKey !== expectedStorageKey) {
    throw new SupabaseDataError("Chave do contrato não corresponde ao identificador do upload.");
  }
  if (input.mimeType !== "application/pdf" || !Number.isSafeInteger(input.fileSize) || input.fileSize <= 0) {
    throw new SupabaseDataError("Metadados do contrato inválidos.");
  }

  const selectColumns =
    "id, family_user_id, caregiver_profile_id, caregiver_user_id, file_name, mime_type, file_size, storage_key, uploaded_by, created_at";
  const existingById = await client
    .from("contract_documents")
    .select(selectColumns)
    .eq("id", contractId)
    .maybeSingle();
  requireNoError("Não foi possível consultar contrato idempotente Supabase", existingById.error);
  if (existingById.data) {
    const row = existingById.data as SupabaseRow;
    if (
      row.storage_key !== input.storageKey ||
      row[column] !== ownerId ||
      row.file_name !== input.fileName ||
      Number(row.file_size) !== input.fileSize
    ) {
      throw new SupabaseDataError("O ticket do contrato não corresponde ao registro existente.");
    }
    return mapContract(row);
  }

  const existingByKey = await client
    .from("contract_documents")
    .select(selectColumns)
    .eq("storage_key", input.storageKey)
    .maybeSingle();
  requireNoError("Não foi possível consultar chave de contrato Supabase", existingByKey.error);
  if (existingByKey.data) {
    const row = existingByKey.data as SupabaseRow;
    if (row.id !== contractId) {
      throw new SupabaseDataError("A chave do contrato já está vinculada a outro registro.");
    }
    return mapContract(row);
  }

  const { data, error } = await client
    .from("contract_documents")
    .insert({
      id: contractId,
      family_user_id: column === "family_user_id" ? ownerId : null,
      caregiver_profile_id: column === "caregiver_profile_id" ? ownerId : null,
      caregiver_user_id: column === "caregiver_user_id" ? ownerId : null,
      file_name: input.fileName,
      mime_type: input.mimeType,
      file_size: input.fileSize,
      storage_key: input.storageKey,
      uploaded_by: uploadedBy,
    })
    .select(selectColumns)
    .single();
  if (!error && data) return mapContract(data as SupabaseRow);

  if (isUniqueViolation(error)) {
    const retry = await client
      .from("contract_documents")
      .select(selectColumns)
      .eq("id", contractId)
      .maybeSingle();
    requireNoError("Não foi possível confirmar contrato idempotente Supabase", retry.error);
    if (retry.data) return mapContract(retry.data as SupabaseRow);
  }
  throw operationError("Não foi possível registrar metadados do contrato Supabase", error);
}

export async function isContractStorageKeyRegistered(storageKey: string): Promise<boolean> {
  const client = serviceClient();
  const { data, error } = await client
    .from("contract_documents")
    .select("id")
    .eq("storage_key", storageKey)
    .maybeSingle();
  requireNoError("Não foi possível verificar contrato temporário Supabase", error);
  return Boolean(data);
}

export async function deleteContractDocument(id: string): Promise<void> {
  const client = await requestClient();
  const contractId = assertUuid(id, "Contrato");
  const { data, error } = await client
    .from("contract_documents")
    .select("storage_key")
    .eq("id", contractId)
    .maybeSingle();
  requireNoError("Não foi possível consultar contrato Supabase", error);
  const key = asNullableString((data as SupabaseRow | null)?.storage_key);
  const { error: deleteError } = await client.from("contract_documents").delete().eq("id", contractId);
  requireNoError("Não foi possível excluir contrato Supabase", deleteError);
  if (key) await cleanupContracts([key]);
}

// ---------- Daily records ----------
export async function listRecordsForPatient(patientId: string, limit = 90): Promise<DailyRecord[]> {
  const client = await requestClient();
  const { data, error } = await client
    .from("daily_records")
    .select("*")
    .eq("patient_id", assertUuid(patientId, "Paciente"))
    .order("record_date", { ascending: false })
    .order("record_time", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 365)));
  requireNoError("Não foi possível listar registros diários Supabase", error);
  return hydratePhotos((data || []) as SupabaseRow[]);
}

export async function getRecord(id: string): Promise<DailyRecord | undefined> {
  const client = await requestClient();
  const { data, error } = await client.from("daily_records").select("*").eq("id", assertUuid(id, "Registro")).maybeSingle();
  requireNoError("Não foi possível consultar registro diário Supabase", error);
  return data ? hydratePhoto(mapDailyRecord(data as SupabaseRow), data as SupabaseRow) : undefined;
}

export async function getRecordForCaregiverOnDate(
  patientId: string,
  caregiverUserId: string,
  recordDate: string,
): Promise<DailyRecord | undefined> {
  const client = await requestClient();
  const { data, error } = await client
    .from("daily_records")
    .select("*")
    .eq("patient_id", assertUuid(patientId, "Paciente"))
    .eq("caregiver_user_id", assertUuid(caregiverUserId, "Cuidador"))
    .eq("record_date", recordDate)
    .order("record_time", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1);
  requireNoError("Não foi possível consultar registro diário Supabase", error);
  const row = ((data || []) as SupabaseRow[])[0];
  return row ? hydratePhoto(mapDailyRecord(row), row) : undefined;
}

export async function createRecord(
  input: Omit<DailyRecord, "id" | "created_at" | "updated_at">,
  actor: RecordAuditActor = { userId: input.caregiver_user_id, name: "Cuidador" },
): Promise<DailyRecord> {
  const client = await requestClient();
  // Audit inserts are intentionally service-role-only in DB-02; resolve the
  // service client before writing the record so a missing secret fails closed.
  const auditClient = serviceClient();
  const id = randomUUID();
  assertUuid(input.patient_id, "Paciente");
  assertUuid(input.caregiver_user_id, "Cuidador");
  assertUuid(actor.userId, "Autor da auditoria");
  let photoKey: string | null = null;
  const row = {
    id,
    patient_id: input.patient_id,
    caregiver_user_id: input.caregiver_user_id,
    record_date: input.record_date,
    record_time: input.record_time,
    bp_systolic: input.bp_systolic,
    bp_diastolic: input.bp_diastolic,
    heart_rate: input.heart_rate,
    temperature: input.temperature,
    spo2: input.spo2,
    glucose: input.glucose,
    medications: input.medications,
    feeding: input.feeding,
    hygiene: input.hygiene,
    mobility: input.mobility,
    mood: input.mood,
    pain_level: input.pain_level,
    notes: input.notes,
    incident: input.incident === 1,
    incident_description: input.incident_description,
    // The Storage INSERT policy relates the object to an existing record, so
    // the row is created first and linked to its object immediately after.
    photo_storage_key: null,
  };
  const { data: insertedData, error } = await client.from("daily_records").insert(row).select("*").single();
  if (error || !insertedData) {
    throw operationError("Não foi possível criar registro diário Supabase", error);
  }
  let persistedData = insertedData as SupabaseRow;
  try {
    if (input.photo_data) {
      photoKey = await uploadRecordPhoto(input.patient_id, id, input.photo_data);
      const { data: linkedData, error: linkError } = await client
        .from("daily_records")
        .update({ photo_storage_key: photoKey })
        .eq("id", id)
        .select("*")
        .single();
      if (linkError || !linkedData) throw operationError("Não foi possível vincular foto ao registro Supabase", linkError);
      persistedData = linkedData as SupabaseRow;
    }
  } catch (error) {
    if (photoKey) await deleteStoredFile(photoKey).catch(() => undefined);
    try {
      await auditClient.from("daily_records").delete().eq("id", id);
    } catch {
      // Keep the original upload/link error as the operation result.
    }
    throw error;
  }
  const snapshot = snapshotDailyRecord(input);
  const { error: auditError } = await auditClient.from("daily_record_audit_events").insert({
    id: randomUUID(),
    record_id: id,
    patient_id: input.patient_id,
    actor_user_id: actor.userId,
    actor_name: actor.name.slice(0, 160),
    action: "created",
    changed_fields: Object.keys(snapshot),
    after_data: snapshot,
  });
  if (auditError) {
    try {
      await auditClient.from("daily_records").delete().eq("id", id);
    } catch {
      // Keep the original audit error as the operation result.
    }
    if (photoKey) await deleteStoredFile(photoKey).catch(() => undefined);
    throw operationError("Não foi possível registrar auditoria do registro Supabase", auditError);
  }
  return hydratePhoto(mapDailyRecord(persistedData), persistedData);
}

export async function updateRecord(
  id: string,
  fields: Partial<Omit<DailyRecord, "id" | "created_at" | "updated_at" | "patient_id" | "caregiver_user_id">>,
  actor: RecordAuditActor,
): Promise<DailyRecord | undefined> {
  const client = await requestClient();
  const auditClient = serviceClient();
  const recordId = assertUuid(id, "Registro");
  const { data: existingData, error: existingError } = await client
    .from("daily_records")
    .select("*")
    .eq("id", recordId)
    .maybeSingle();
  requireNoError("Não foi possível consultar registro diário Supabase", existingError);
  if (!existingData) return undefined;
  const existingRow = existingData as SupabaseRow;
  const existing = await hydratePhoto(mapDailyRecord(existingRow), existingRow);
  const merged = { ...existing, ...fields };
  const changedFields = diffDailyRecord(existing, merged);
  if (!changedFields.length) return existing;
  assertUuid(actor.userId, "Autor da auditoria");

  let newPhotoKey = asNullableString(existingRow.photo_storage_key);
  let uploadedPhotoKey: string | null = null;
  if ("photo_data" in fields) {
    if (fields.photo_data) {
      uploadedPhotoKey = await uploadRecordPhoto(existing.patient_id, recordId, fields.photo_data);
      newPhotoKey = uploadedPhotoKey;
    } else {
      storageEnabled();
      newPhotoKey = null;
    }
  }
  const update: SupabaseRow = {};
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
  ] as const;
  for (const key of allowed) {
    if (key in fields) update[key] = key === "incident" ? fields[key] === 1 : fields[key] ?? null;
  }
  if ("photo_data" in fields) update.photo_storage_key = newPhotoKey;
  update.updated_at = new Date().toISOString();
  const { data: updatedData, error: updateError } = await client
    .from("daily_records")
    .update(update)
    .eq("id", recordId)
    .select("*")
    .single();
  if (updateError || !updatedData) {
    if (uploadedPhotoKey) await deleteStoredFile(uploadedPhotoKey).catch(() => undefined);
    throw operationError("Não foi possível atualizar registro diário Supabase", updateError);
  }
  const { error: auditError } = await auditClient.from("daily_record_audit_events").insert({
    id: randomUUID(),
    record_id: recordId,
    patient_id: existing.patient_id,
    actor_user_id: actor.userId,
    actor_name: actor.name.slice(0, 160),
    action: "updated",
    changed_fields: changedFields,
    before_data: snapshotDailyRecord(existing),
    after_data: snapshotDailyRecord(merged),
  });
  if (auditError) {
    try {
      await client.from("daily_records").update({
        ...Object.fromEntries(allowed.filter((key) => key in existing).map((key) => [key, key === "incident" ? existing[key] === 1 : existing[key] ?? null])),
        photo_storage_key: existingRow.photo_storage_key ?? null,
        updated_at: existing.updated_at,
      }).eq("id", recordId);
    } catch {
      // Keep the original audit error as the operation result.
    }
    if (uploadedPhotoKey) await deleteStoredFile(uploadedPhotoKey).catch(() => undefined);
    throw operationError("Não foi possível registrar auditoria da atualização Supabase", auditError);
  }
  const oldPhotoKey = asNullableString(existingRow.photo_storage_key);
  if (oldPhotoKey && oldPhotoKey !== newPhotoKey) await deleteStoredFile(oldPhotoKey).catch(() => undefined);
  return hydratePhoto(mapDailyRecord(updatedData as SupabaseRow), updatedData as SupabaseRow);
}

export async function deleteRecord(id: string): Promise<boolean> {
  const client = await requestClient();
  const recordId = assertUuid(id, "Registro");
  const { data, error: selectError } = await client
    .from("daily_records")
    .select("photo_storage_key")
    .eq("id", recordId)
    .maybeSingle();
  requireNoError("Não foi possível consultar registro diário Supabase", selectError);
  if (!data) return false;

  const photoKey = asNullableString((data as SupabaseRow).photo_storage_key);
  const { error: deleteError } = await client.from("daily_records").delete().eq("id", recordId);
  requireNoError("Não foi possível excluir registro diário Supabase", deleteError);
  if (photoKey) await cleanupContracts([photoKey]);
  return true;
}

export async function listRecordAuditForPatient(patientId: string, limit = 50): Promise<DailyRecordAuditEvent[]> {
  const client = await requestClient();
  const { data, error } = await client
    .from("daily_record_audit_events")
    .select("*")
    .eq("patient_id", assertUuid(patientId, "Paciente"))
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 200)));
  requireNoError("Não foi possível listar auditoria Supabase", error);
  return ((data || []) as SupabaseRow[]).map(mapAuditEvent);
}

export async function countPendingLeads(): Promise<number> {
  const client = await requestClient();
  const { count, error } = await client
    .from("leads")
    .select("id", { count: "exact", head: true })
    .in("status", ["novo", "em_contato"]);
  requireNoError("Não foi possível contar leads pendentes Supabase", error);
  return count || 0;
}

export async function getCaregiverName(id: string): Promise<string> {
  const user = await getUserById(assertUuid(id, "Cuidador"));
  return user?.name || "Cuidador";
}

export async function getCaregiverNamesMap(ids: string[]): Promise<Record<string, string>> {
  const users = await getUsersByIds([...new Set(ids)]);
  return Object.fromEntries(users.map((user) => [user.id, user.name]));
}

export async function getFinanceDashboardSnapshot(month: string): Promise<FinanceDashboardSnapshot> {
  const client = await requestClient();
  const start = `${month}-01`;
  const end = `${shiftFinanceMonth(month, 1)}-01`;
  const chartRange = financeChartRange(month);

  const [chargesResult, expensesResult, receiptsResult, paymentsResult] = await Promise.all([
    client
      .from("finance_charges")
      .select("*")
      .eq("competence_month", start)
      .order("due_date", { ascending: true })
      .order("created_at", { ascending: true }),
    client
      .from("finance_expenses")
      .select("*")
      .gte("expense_date", start)
      .lt("expense_date", end)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false }),
    client
      .from("finance_receipts")
      .select("received_on,amount_cents")
      .gte("received_on", chartRange.start)
      .lt("received_on", chartRange.end),
    client
      .from("finance_expenses")
      .select("paid_on,amount_cents")
      .not("paid_on", "is", null)
      .gte("paid_on", chartRange.start)
      .lt("paid_on", chartRange.end),
  ]);

  requireNoError("Não foi possível listar cobranças financeiras Supabase", chargesResult.error);
  requireNoError("Não foi possível listar despesas financeiras Supabase", expensesResult.error);
  requireNoError("Não foi possível consultar recebimentos financeiros Supabase", receiptsResult.error);
  requireNoError("Não foi possível consultar pagamentos financeiros Supabase", paymentsResult.error);

  const chargeRows = (chargesResult.data || []) as SupabaseRow[];
  const expenseRows = (expensesResult.data || []) as SupabaseRow[];
  const scheduleEntryIds = [...new Set(
    expenseRows
      .map((row) => asNullableString(row.caregiver_schedule_entry_id))
      .filter((id): id is string => Boolean(id)),
  )];
  const patientNameByScheduleEntryId = new Map<string, string>();
  if (scheduleEntryIds.length > 0) {
    const { data: scheduleRows, error: scheduleError } = await client
      .from("caregiver_schedule_entries")
      .select("id,assignment:caregiver_assignments!caregiver_schedule_entries_caregiver_assignment_id_fkey(patient:patients!caregiver_assignments_patient_id_fkey(name))")
      .in("id", scheduleEntryIds);
    requireNoError("Não foi possível consultar os pacientes dos plantões Supabase", scheduleError);
    for (const scheduleRow of (scheduleRows || []) as SupabaseRow[]) {
      const assignment = scheduleRow.assignment as SupabaseRow | null;
      const patient = assignment?.patient as SupabaseRow | null;
      const patientName = asNullableString(patient?.name);
      if (patientName) patientNameByScheduleEntryId.set(asString(scheduleRow.id), patientName);
    }
  }
  const receiptTotals = new Map<string, number>();
  if (chargeRows.length > 0) {
    const chargeIds = chargeRows.map((row) => assertUuid(asString(row.id), "Cobrança"));
    const { data, error } = await client
      .from("finance_receipts")
      .select("charge_id,amount_cents")
      .in("charge_id", chargeIds);
    requireNoError("Não foi possível totalizar recebimentos das cobranças Supabase", error);
    for (const row of (data || []) as SupabaseRow[]) {
      const chargeId = asString(row.charge_id);
      receiptTotals.set(
        chargeId,
        (receiptTotals.get(chargeId) || 0) + (asNumber(row.amount_cents) || 0),
      );
    }
  }

  const receipts: FinanceReceiptMovement[] = ((receiptsResult.data || []) as SupabaseRow[]).map(
    (row) => ({
      received_on: asString(row.received_on),
      amount_cents: asNumber(row.amount_cents) || 0,
    }),
  );
  const payments: FinanceExpensePaymentMovement[] = ((paymentsResult.data || []) as SupabaseRow[]).map(
    (row) => ({
      paid_on: asString(row.paid_on),
      amount_cents: asNumber(row.amount_cents) || 0,
    }),
  );

  return {
    month,
    charges: chargeRows.map((row) =>
      mapFinanceCharge(row, receiptTotals.get(asString(row.id)) || 0),
    ),
    expenses: expenseRows.map((row) => {
      const scheduleEntryId = asNullableString(row.caregiver_schedule_entry_id);
      const patientName = scheduleEntryId ? patientNameByScheduleEntryId.get(scheduleEntryId) || null : null;
      return mapFinanceExpense(row, patientName);
    }),
    cash_flow: buildFinanceCashFlow(month, receipts, payments),
  };
}

export async function createFinanceCharge(
  input: FinanceChargeInput,
  actorId: string,
): Promise<void> {
  const client = await requestClient();
  const { error } = await client.from("finance_charges").insert({
    label: input.label,
    competence_month: `${input.competence_month}-01`,
    due_date: input.due_date,
    amount_cents: input.amount_cents,
    created_by: assertUuid(actorId, "Responsável"),
  });
  requireNoError("Não foi possível cadastrar cobrança financeira Supabase", error);
}

export async function updateFinanceCharge(
  id: string,
  input: FinanceChargeInput,
): Promise<void> {
  const client = await requestClient();
  const chargeId = assertUuid(id, "Cobrança");
  const { data: existing, error: selectError } = await client
    .from("finance_charges")
    .select("id")
    .eq("id", chargeId)
    .maybeSingle();
  requireNoError("Não foi possível consultar cobrança financeira Supabase", selectError);
  if (!existing) throw new FinanceNotFoundError("Cobrança não encontrada.");

  const { data: receiptRows, error: receiptError } = await client
    .from("finance_receipts")
    .select("amount_cents")
    .eq("charge_id", chargeId);
  requireNoError("Não foi possível consultar recebimentos da cobrança Supabase", receiptError);
  const alreadyReceived = ((receiptRows || []) as SupabaseRow[]).reduce(
    (total, row) => total + (asNumber(row.amount_cents) || 0),
    0,
  );
  if (input.amount_cents < alreadyReceived) {
    throw new FinanceConflictError("O valor da cobrança não pode ficar abaixo dos recebimentos já registrados.");
  }

  const { error } = await client
    .from("finance_charges")
    .update({
      label: input.label,
      competence_month: `${input.competence_month}-01`,
      due_date: input.due_date,
      amount_cents: input.amount_cents,
      updated_at: new Date().toISOString(),
    })
    .eq("id", chargeId);
  if (error) {
    const translated = operationError("Não foi possível atualizar cobrança financeira Supabase", error);
    if (translated.message.includes("FINANCE_CHARGE_BELOW_RECEIVED")) {
      throw new FinanceConflictError("O valor da cobrança não pode ficar abaixo dos recebimentos já registrados.");
    }
    throw translated;
  }
}

export async function deleteFinanceCharge(id: string): Promise<void> {
  const client = await requestClient();
  const chargeId = assertUuid(id, "Cobrança");
  const { data, error } = await client
    .from("finance_charges")
    .delete()
    .eq("id", chargeId)
    .select("id")
    .maybeSingle();
  requireNoError("Não foi possível excluir cobrança financeira Supabase", error);
  if (!data) throw new FinanceNotFoundError("Cobrança não encontrada.");
}

export async function recordFinanceReceipt(
  chargeId: string,
  input: FinanceReceiptInput,
  actorId: string,
): Promise<void> {
  const client = await requestClient();
  const validChargeId = assertUuid(chargeId, "Cobrança");
  const { data: charge, error: chargeError } = await client
    .from("finance_charges")
    .select("id,amount_cents")
    .eq("id", validChargeId)
    .maybeSingle();
  requireNoError("Não foi possível consultar cobrança financeira Supabase", chargeError);
  if (!charge) throw new FinanceNotFoundError("Cobrança não encontrada.");

  const { data: receiptRows, error: receiptError } = await client
    .from("finance_receipts")
    .select("amount_cents")
    .eq("charge_id", validChargeId);
  requireNoError("Não foi possível consultar recebimentos da cobrança Supabase", receiptError);
  const alreadyReceived = ((receiptRows || []) as SupabaseRow[]).reduce(
    (total, row) => total + (asNumber(row.amount_cents) || 0),
    0,
  );
  if (alreadyReceived + input.amount_cents > (asNumber((charge as SupabaseRow).amount_cents) || 0)) {
    throw new FinanceConflictError();
  }

  const { error } = await client.from("finance_receipts").insert({
    charge_id: validChargeId,
    received_on: input.received_on,
    amount_cents: input.amount_cents,
    created_by: assertUuid(actorId, "Responsável"),
  });
  if (error) {
    const translated = operationError("Não foi possível registrar recebimento Supabase", error);
    if (translated.message.includes("FINANCE_RECEIPT_EXCEEDS_CHARGE")) {
      throw new FinanceConflictError();
    }
    throw translated;
  }
}

export async function createFinanceExpense(
  input: FinanceExpenseInput,
  actorId: string,
): Promise<void> {
  const client = await requestClient();
  const { error } = await client.from("finance_expenses").insert({
    expense_date: input.expense_date,
    category: input.category,
    description: input.description,
    amount_cents: input.amount_cents,
    paid_on: input.paid_on,
    created_by: assertUuid(actorId, "Responsável"),
  });
  requireNoError("Não foi possível cadastrar despesa financeira Supabase", error);
}

export async function updateFinanceExpense(
  id: string,
  input: FinanceExpenseInput,
): Promise<void> {
  const client = await requestClient();
  const expenseId = assertUuid(id, "Despesa");
  const { data: current, error: currentError } = await client
    .from("finance_expenses")
    .select("id,category,caregiver_schedule_entry_id")
    .eq("id", expenseId)
    .maybeSingle();
  requireNoError("Não foi possível consultar despesa financeira Supabase", currentError);
  if (!current) throw new FinanceNotFoundError("Despesa não encontrada.");
  const currentRow = current as SupabaseRow;
  if (asString(currentRow.category) === "equipe" || asNullableString(currentRow.caregiver_schedule_entry_id)) {
    throw new FinanceConflictError("Este valor é calculado pela escala. Atualize apenas a data de pagamento.");
  }
  const { data, error } = await client
    .from("finance_expenses")
    .update({
      expense_date: input.expense_date,
      category: input.category,
      description: input.description,
      amount_cents: input.amount_cents,
      paid_on: input.paid_on,
      updated_at: new Date().toISOString(),
    })
    .eq("id", expenseId)
    .select("id")
    .maybeSingle();
  requireNoError("Não foi possível atualizar despesa financeira Supabase", error);
  if (!data) throw new FinanceNotFoundError("Despesa não encontrada.");
}

export async function updateFinancePayrollExpense(
  id: string,
  input: FinancePayrollExpenseUpdate,
): Promise<void> {
  const client = await requestClient();
  const expenseId = assertUuid(id, "Despesa");
  const { data: current, error: currentError } = await client
    .from("finance_expenses")
    .select("id,category,caregiver_schedule_entry_id,amount_cents,caregiver_payroll_amount_overridden")
    .eq("id", expenseId)
    .maybeSingle();
  requireNoError("Não foi possível consultar plantão financeiro Supabase", currentError);
  if (!current) throw new FinanceNotFoundError("Pagamento de plantão não encontrado.");
  const currentRow = current as SupabaseRow;
  if (asString(currentRow.category) !== "equipe") {
    throw new FinanceConflictError("Esta despesa não é um pagamento automático da equipe.");
  }
  if (!asNullableString(currentRow.caregiver_schedule_entry_id)) {
    throw new FinanceConflictError("Este pagamento pertence a uma escala removida e foi preservado como histórico.");
  }
  const previousAmount = asNumber(currentRow.amount_cents) ?? 0;
  const alreadyOverridden = asBoolean(currentRow.caregiver_payroll_amount_overridden);
  const { data, error } = await client
    .from("finance_expenses")
    .update({
      amount_cents: input.amount_cents,
      paid_on: input.paid_on,
      caregiver_payroll_amount_overridden: alreadyOverridden || input.amount_cents !== previousAmount,
      updated_at: new Date().toISOString(),
    })
    .eq("id", expenseId)
    .eq("category", "equipe")
    .not("caregiver_schedule_entry_id", "is", null)
    .select("id")
    .maybeSingle();
  requireNoError("Não foi possível atualizar plantão financeiro Supabase", error);
  if (!data) throw new FinanceNotFoundError("Pagamento de plantão não encontrado.");
}

export async function updateFinanceExpensePayment(id: string, paidOn: string | null): Promise<void> {
  const client = await requestClient();
  const expenseId = assertUuid(id, "Despesa");
  const { data: current, error: currentError } = await client
    .from("finance_expenses")
    .select("id,category,caregiver_schedule_entry_id")
    .eq("id", expenseId)
    .maybeSingle();
  requireNoError("Não foi possível consultar pagamento de plantão Supabase", currentError);
  if (!current) throw new FinanceNotFoundError("Pagamento de plantão não encontrado.");
  if (asString((current as SupabaseRow).category) !== "equipe") {
    throw new FinanceConflictError("Esta despesa não é um pagamento automático da equipe.");
  }
  if (!asNullableString((current as SupabaseRow).caregiver_schedule_entry_id)) {
    throw new FinanceConflictError("Este pagamento pertence a uma escala removida e foi preservado como histórico.");
  }
  const { data, error } = await client
    .from("finance_expenses")
    .update({ paid_on: paidOn, updated_at: new Date().toISOString() })
    .eq("id", expenseId)
    .eq("category", "equipe")
    .not("caregiver_schedule_entry_id", "is", null)
    .select("id")
    .maybeSingle();
  requireNoError("Não foi possível atualizar pagamento de plantão Supabase", error);
  if (!data) throw new FinanceNotFoundError("Pagamento de plantão não encontrado.");
}

export async function deleteFinanceExpense(id: string): Promise<void> {
  const client = await requestClient();
  const expenseId = assertUuid(id, "Despesa");
  const { data: current, error: currentError } = await client
    .from("finance_expenses")
    .select("id,category,caregiver_schedule_entry_id")
    .eq("id", expenseId)
    .maybeSingle();
  requireNoError("Não foi possível consultar despesa financeira Supabase", currentError);
  if (!current) throw new FinanceNotFoundError("Despesa não encontrada.");
  const currentRow = current as SupabaseRow;
  if (asString(currentRow.category) === "equipe" || asNullableString(currentRow.caregiver_schedule_entry_id)) {
    throw new FinanceConflictError("Este lançamento é gerado pela escala e não pode ser excluído manualmente.");
  }
  const { data, error } = await client
    .from("finance_expenses")
    .delete()
    .eq("id", expenseId)
    .select("id")
    .maybeSingle();
  requireNoError("Não foi possível excluir despesa financeira Supabase", error);
  if (!data) throw new FinanceNotFoundError("Despesa não encontrada.");
}
