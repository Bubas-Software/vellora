import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    password_hash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "coordenador_operacional", "familia", "cuidador"] }).notNull(),
    phone: text("phone"),
    session_version: integer("session_version").notNull().default(1),
    deleted_at: text("deleted_at"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    check("users_role_check", sql`${table.role} IN ('admin','coordenador_operacional','familia','cuidador')`),
  ]
);

export const userRoleMemberships = sqliteTable(
  "user_role_memberships",
  {
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["admin", "coordenador_operacional", "familia", "cuidador"] }).notNull(),
    active: integer("active").notNull().default(1),
    is_default: integer("is_default").notNull().default(0),
    granted_by: text("granted_by").references(() => users.id, { onDelete: "set null" }),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.user_id, table.role] }),
    index("idx_user_role_memberships_active").on(table.user_id, table.active),
    check(
      "user_role_memberships_role_check",
      sql`${table.role} IN ('admin','coordenador_operacional','familia','cuidador')`,
    ),
    check("user_role_memberships_active_check", sql`${table.active} IN (0,1)`),
    check("user_role_memberships_default_check", sql`${table.is_default} IN (0,1)`),
  ],
);

export const passwordResetTokens = sqliteTable(
  "password_reset_tokens",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token_hash: text("token_hash").notNull(),
    expires_at: text("expires_at").notNull(),
    used_at: text("used_at"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("password_reset_tokens_hash_unique").on(table.token_hash),
    index("idx_password_reset_user").on(table.user_id, table.created_at),
    index("idx_password_reset_expiry").on(table.expires_at),
  ]
);

export const adminRecoveryEvents = sqliteTable("admin_recovery_events", {
  recovery_hash: text("recovery_hash").primaryKey(),
  admin_user_id: text("admin_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  applied_at: text("applied_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const patients = sqliteTable("patients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  birth_date: text("birth_date"),
  address: text("address"),
  care_level: text("care_level"),
  condition_summary: text("condition_summary"),
  family_user_id: text("family_user_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status", { enum: ["pendente", "ativo", "inativo"] })
    .notNull()
    .default("pendente"),
  notes: text("notes"),
  created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const caregiverAssignments = sqliteTable(
  "caregiver_assignments",
  {
    id: text("id").primaryKey(),
    patient_id: text("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    caregiver_user_id: text("caregiver_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    start_date: text("start_date").notNull(),
    end_date: text("end_date"),
    active: integer("active").notNull().default(1),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_assignments_patient").on(table.patient_id),
    index("idx_assignments_caregiver").on(table.caregiver_user_id),
  ]
);

export const caregiverScheduleEntries = sqliteTable(
  "caregiver_schedule_entries",
  {
    id: text("id").primaryKey(),
    caregiver_assignment_id: text("caregiver_assignment_id")
      .notNull()
      .references(() => caregiverAssignments.id, { onDelete: "restrict" }),
    scheduled_date: text("scheduled_date").notNull(),
    start_time: text("start_time").notNull(),
    end_time: text("end_time").notNull(),
    ends_next_day: integer("ends_next_day", { mode: "boolean" }).notNull().default(false),
    profession: text("profession", {
      enum: ["cuidador", "tecnico_enfermagem", "enfermeiro", "outros"],
    }).notNull(),
    payroll_amount_override_cents: integer("payroll_amount_override_cents"),
    payroll_rate_status: text("payroll_rate_status", {
      enum: ["valor_pendente", "gerado"],
    })
      .notNull()
      .default("valor_pendente"),
    created_by: text("created_by").references(() => users.id, { onDelete: "set null" }),
    updated_by: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_schedule_assignment_date").on(
      table.caregiver_assignment_id,
      table.scheduled_date,
      table.start_time,
    ),
    index("idx_schedule_date_assignment").on(table.scheduled_date, table.caregiver_assignment_id),
    check(
      "caregiver_schedule_entries_profession_check",
      sql`${table.profession} IN ('cuidador','tecnico_enfermagem','enfermeiro','outros')`,
    ),
    check(
      "caregiver_schedule_entries_payroll_rate_status_check",
      sql`${table.payroll_rate_status} IN ('valor_pendente','gerado')`,
    ),
    check(
      "caregiver_schedule_entries_payroll_amount_override_range",
      sql`${table.payroll_amount_override_cents} IS NULL OR ${table.payroll_amount_override_cents} BETWEEN 1 AND 100000000`,
    ),
    check(
      "caregiver_schedule_entries_time_order",
      sql`(${table.ends_next_day} = 0 AND ${table.end_time} > ${table.start_time}) OR (${table.ends_next_day} = 1 AND ${table.end_time} <= ${table.start_time})`,
    ),
  ],
);

export const familyPatientServiceRates = sqliteTable(
  "family_patient_service_rates",
  {
    id: text("id").primaryKey(),
    family_user_id: text("family_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    patient_id: text("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    profession: text("profession", {
      enum: ["cuidador", "tecnico_enfermagem", "enfermeiro", "outros"],
    }).notNull(),
    amount_cents: integer("amount_cents").notNull(),
    valid_from: text("valid_from").notNull(),
    valid_to: text("valid_to"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_family_patient_service_rates_lookup").on(
      table.family_user_id,
      table.patient_id,
      table.profession,
      table.valid_from,
    ),
    check(
      "family_patient_service_rates_profession_check",
      sql`${table.profession} IN ('cuidador','tecnico_enfermagem','enfermeiro','outros')`,
    ),
    check(
      "family_patient_service_rates_amount_check",
      sql`${table.amount_cents} > 0 AND ${table.amount_cents} <= 100000000`,
    ),
    check(
      "family_patient_service_rates_valid_dates_check",
      sql`${table.valid_to} IS NULL OR ${table.valid_to} >= ${table.valid_from}`,
    ),
  ],
);

export const leads = sqliteTable(
  "leads",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    patient_name: text("patient_name"),
    care_type: text("care_type"),
    message: text("message"),
    status: text("status", { enum: ["novo", "em_contato", "convertido", "recusado"] })
      .notNull()
      .default("novo"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_leads_status_created").on(table.status, table.created_at)]
);

export const professionalApplications = sqliteTable(
  "professional_applications",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    city: text("city"),
    profession: text("profession", {
      enum: ["cuidador", "tecnico_enfermagem", "enfermeiro", "outros"],
    }).notNull(),
    coren: text("coren"),
    experience: text("experience"),
    availability_days: text("availability_days", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    availability_shifts: text("availability_shifts", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    available_from: text("available_from"),
    notes: text("notes"),
    status: text("status", { enum: ["novo", "em_analise", "aprovado", "recusado"] })
      .notNull()
      .default("novo"),
    lgpd_consent: integer("lgpd_consent", { mode: "boolean" }).notNull().default(false),
    lgpd_consent_at: text("lgpd_consent_at"),
    privacy_notice_version: text("privacy_notice_version"),
    reviewed_at: text("reviewed_at"),
    reviewed_by: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_professional_applications_status").on(table.status, table.created_at)]
);

export const caregiverProfiles = sqliteTable(
  "caregiver_profiles",
  {
    id: text("id").primaryKey(),
    application_id: text("application_id").references(() => professionalApplications.id, {
      onDelete: "set null",
    }),
    user_id: text("user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    contact_email: text("contact_email").notNull(),
    phone: text("phone").notNull(),
    city: text("city"),
    profession: text("profession", {
      enum: ["cuidador", "tecnico_enfermagem", "enfermeiro", "outros"],
    }).notNull(),
    coren: text("coren"),
    experience: text("experience"),
    availability_days: text("availability_days", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    availability_shifts: text("availability_shifts", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    available_from: text("available_from"),
    notes: text("notes"),
    account_status: text("account_status", {
      enum: ["aguardando_acesso", "ativo", "inativo"],
    })
      .notNull()
      .default("aguardando_acesso"),
    approved_at: text("approved_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("caregiver_profiles_application_unique").on(table.application_id),
    uniqueIndex("caregiver_profiles_user_unique").on(table.user_id),
    index("idx_caregiver_profiles_status").on(table.account_status, table.approved_at),
  ]
);

export const dailyRecords = sqliteTable(
  "daily_records",
  {
    id: text("id").primaryKey(),
    patient_id: text("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    caregiver_user_id: text("caregiver_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    record_date: text("record_date").notNull(),
    record_time: text("record_time"),
    bp_systolic: integer("bp_systolic"),
    bp_diastolic: integer("bp_diastolic"),
    heart_rate: integer("heart_rate"),
    temperature: real("temperature"),
    spo2: integer("spo2"),
    glucose: integer("glucose"),
    medications: text("medications"),
    feeding: text("feeding"),
    hygiene: text("hygiene"),
    mobility: text("mobility"),
    mood: text("mood"),
    pain_level: integer("pain_level"),
    notes: text("notes"),
    incident: integer("incident").notNull().default(0),
    incident_description: text("incident_description"),
    photo_data: text("photo_data"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_records_patient").on(table.patient_id, table.record_date)]
);

export const dailyRecordAuditEvents = sqliteTable(
  "daily_record_audit_events",
  {
    id: text("id").primaryKey(),
    record_id: text("record_id")
      .notNull()
      .references(() => dailyRecords.id, { onDelete: "cascade" }),
    patient_id: text("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    actor_user_id: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actor_name: text("actor_name").notNull(),
    action: text("action", { enum: ["created", "updated"] }).notNull(),
    changed_fields: text("changed_fields", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    before_data: text("before_data"),
    after_data: text("after_data"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_record_audit_record").on(table.record_id, table.created_at),
    index("idx_record_audit_patient").on(table.patient_id, table.created_at),
    check("daily_record_audit_action_check", sql`${table.action} IN ('created','updated')`),
  ]
);

export const rateLimitBuckets = sqliteTable("rate_limit_buckets", {
  bucket_key: text("bucket_key").primaryKey(),
  count: integer("count").notNull().default(0),
  expires_at: text("expires_at").notNull(),
  created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const contractDocuments = sqliteTable(
  "contract_documents",
  {
    id: text("id").primaryKey(),
    family_user_id: text("family_user_id").references(() => users.id, { onDelete: "cascade" }),
    caregiver_profile_id: text("caregiver_profile_id").references(() => caregiverProfiles.id, {
      onDelete: "cascade",
    }),
    caregiver_user_id: text("caregiver_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    file_name: text("file_name").notNull(),
    mime_type: text("mime_type").notNull(),
    file_size: integer("file_size").notNull(),
    storage_key: text("storage_key").notNull(),
    uploaded_by: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("contract_documents_storage_key_unique").on(table.storage_key),
    index("idx_contract_documents_family").on(table.family_user_id, table.created_at),
    index("idx_contract_documents_profile").on(table.caregiver_profile_id, table.created_at),
    index("idx_contract_documents_caregiver").on(table.caregiver_user_id, table.created_at),
    check(
      "contract_documents_single_owner",
      sql`(${table.family_user_id} IS NOT NULL) + (${table.caregiver_profile_id} IS NOT NULL) + (${table.caregiver_user_id} IS NOT NULL) = 1`
    ),
  ]
);

export const financeCharges = sqliteTable(
  "finance_charges",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    competence_month: text("competence_month").notNull(),
    due_date: text("due_date").notNull(),
    amount_cents: integer("amount_cents").notNull(),
    created_by: text("created_by").references(() => users.id, { onDelete: "set null" }),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_finance_charges_month_due").on(table.competence_month, table.due_date),
    check("finance_charges_amount_positive", sql`${table.amount_cents} > 0`),
    check("finance_charges_label_nonempty", sql`length(trim(${table.label})) > 0`),
  ],
);

export const financeReceipts = sqliteTable(
  "finance_receipts",
  {
    id: text("id").primaryKey(),
    charge_id: text("charge_id")
      .notNull()
      .references(() => financeCharges.id, { onDelete: "cascade" }),
    received_on: text("received_on").notNull(),
    amount_cents: integer("amount_cents").notNull(),
    created_by: text("created_by").references(() => users.id, { onDelete: "set null" }),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_finance_receipts_charge").on(table.charge_id, table.received_on),
    index("idx_finance_receipts_date").on(table.received_on),
    check("finance_receipts_amount_positive", sql`${table.amount_cents} > 0`),
  ],
);

export const financeExpenses = sqliteTable(
  "finance_expenses",
  {
    id: text("id").primaryKey(),
    expense_date: text("expense_date").notNull(),
    category: text("category", {
      enum: ["marketing", "sistema", "contabilidade", "impostos", "equipe", "operacao", "outros"],
    }).notNull(),
    description: text("description").notNull(),
    amount_cents: integer("amount_cents").notNull(),
    paid_on: text("paid_on"),
    caregiver_schedule_entry_id: text("caregiver_schedule_entry_id").references(
      () => caregiverScheduleEntries.id,
      { onDelete: "set null" },
    ),
    caregiver_user_id: text("caregiver_user_id").references(() => users.id, { onDelete: "set null" }),
    payee: text("payee"),
    caregiver_payroll_amount_overridden: integer("caregiver_payroll_amount_overridden", { mode: "boolean" })
      .notNull()
      .default(false),
    created_by: text("created_by").references(() => users.id, { onDelete: "set null" }),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_finance_expenses_date").on(table.expense_date),
    index("idx_finance_expenses_paid_on").on(table.paid_on),
    index("idx_finance_expenses_caregiver_user").on(table.caregiver_user_id),
    uniqueIndex("finance_expenses_schedule_entry_unique").on(table.caregiver_schedule_entry_id),
    check("finance_expenses_amount_positive", sql`${table.amount_cents} > 0`),
    check(
      "finance_expenses_category_valid",
      sql`${table.category} IN ('marketing','sistema','contabilidade','impostos','equipe','operacao','outros')`,
    ),
    check("finance_expenses_description_nonempty", sql`length(trim(${table.description})) > 0`),
  ],
);
