export type ScheduleProfession = "cuidador" | "tecnico_enfermagem" | "enfermeiro" | "outros";

export type ScheduleEntry = {
  id: string;
  patient_id: string;
  caregiver_user_id: string;
  scheduled_date: string;
  start_time: string;
  end_time: string;
  ends_next_day: boolean;
  profession: ScheduleProfession;
  payroll_amount_override_cents?: number | null;
  payroll_rate_status?: "valor_pendente" | "gerado";
  professional_name?: string;
  professional_phone?: string;
  patient_name?: string;
};

export type ProfessionalOption = {
  user_id: string;
  name: string;
  profession: ScheduleProfession;
  phone?: string;
  start_date: string;
  end_date?: string | null;
};

export type SchedulePatientOption = { id: string; name: string };

export type SchedulePatientSummary = SchedulePatientOption & {
  status: "pendente" | "ativo" | "inativo";
  careLevel: string | null;
  familyName: string | null;
};
