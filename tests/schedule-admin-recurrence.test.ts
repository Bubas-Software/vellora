import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPatient: vi.fn(),
  getCaregiverProfileByUserId: vi.fn(),
  listAssignmentsForPatient: vi.fn(),
  listCaregiverScheduleEntriesForProfessional: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getPatient: mocks.getPatient,
  getCaregiverProfileByUserId: mocks.getCaregiverProfileByUserId,
  listAssignmentsForPatient: mocks.listAssignmentsForPatient,
  listCaregiverScheduleEntriesForProfessional: mocks.listCaregiverScheduleEntriesForProfessional,
}));

import {
  parseRecurringScheduleMutation,
  resolveRecurringScheduleMutation,
} from "@/lib/schedule-admin";

const patientId = "11111111-1111-4111-8111-111111111111";
const caregiverId = "22222222-2222-4222-8222-222222222222";

function body(overrides: Record<string, unknown> = {}) {
  return {
    patient_id: patientId,
    caregiver_user_id: caregiverId,
    start_date: "2026-10-05",
    end_date: "2026-10-09",
    start_time: "08:00",
    end_time: "20:00",
    ends_next_day: false,
    pattern: "weekdays",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPatient.mockResolvedValue({ status: "ativo" });
  mocks.getCaregiverProfileByUserId.mockResolvedValue({ account_status: "ativo", profession: "enfermeiro" });
  mocks.listAssignmentsForPatient.mockResolvedValue([{
    id: "33333333-3333-4333-8333-333333333333",
    caregiver_user_id: caregiverId,
    start_date: "2026-10-05",
    end_date: null,
    active: 1,
  }]);
  mocks.listCaregiverScheduleEntriesForProfessional.mockResolvedValue([]);
});

describe("recorrência de escalas", () => {
  it("valida e expande o padrão informado em datas individuais", () => {
    expect(parseRecurringScheduleMutation(body())).toEqual({
      data: {
        patient_id: patientId,
        caregiver_user_id: caregiverId,
        start_date: "2026-10-05",
        end_date: "2026-10-09",
        start_time: "08:00",
        end_time: "20:00",
        ends_next_day: false,
        dates: ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"],
      },
    });
  });

  it("rejeita datas sem ocorrência válida e horários incorretos", () => {
    expect(parseRecurringScheduleMutation(body({ pattern: "invalid" })).error).toContain("padrão");
    expect(parseRecurringScheduleMutation(body({ start_time: "20:00", end_time: "08:00" })).error).toContain("posterior");
  });

  it("rejeita recorrências para pacientes inativos", async () => {
    mocks.getPatient.mockResolvedValue({ status: "inativo" });
    const parsed = parseRecurringScheduleMutation(body());
    if (!parsed.data) throw new Error(parsed.error);

    await expect(resolveRecurringScheduleMutation(parsed.data)).resolves.toMatchObject({
      error: expect.stringContaining("paciente inativo"),
    });
    expect(mocks.listAssignmentsForPatient).not.toHaveBeenCalled();
  });

  it("associa cada data ao vínculo ativo correspondente", async () => {
    mocks.listAssignmentsForPatient.mockResolvedValue([
      { id: "33333333-3333-4333-8333-333333333333", caregiver_user_id: caregiverId, start_date: "2026-10-05", end_date: "2026-10-07", active: 1 },
      { id: "44444444-4444-4444-8444-444444444444", caregiver_user_id: caregiverId, start_date: "2026-10-08", end_date: null, active: 1 },
    ]);
    const parsed = parseRecurringScheduleMutation(body());
    if (!parsed.data) throw new Error(parsed.error);

    await expect(resolveRecurringScheduleMutation(parsed.data)).resolves.toMatchObject({
      data: [
        { caregiver_assignment_id: "33333333-3333-4333-8333-333333333333", scheduled_date: "2026-10-05", profession: "enfermeiro" },
        { caregiver_assignment_id: "33333333-3333-4333-8333-333333333333", scheduled_date: "2026-10-06", profession: "enfermeiro" },
        { caregiver_assignment_id: "33333333-3333-4333-8333-333333333333", scheduled_date: "2026-10-07", profession: "enfermeiro" },
        { caregiver_assignment_id: "44444444-4444-4444-8444-444444444444", scheduled_date: "2026-10-08", profession: "enfermeiro" },
        { caregiver_assignment_id: "44444444-4444-4444-8444-444444444444", scheduled_date: "2026-10-09", profession: "enfermeiro" },
      ],
    });
  });

  it("interrompe a pré-validação se o vínculo terminar antes de uma ocorrência", async () => {
    mocks.listAssignmentsForPatient.mockResolvedValue([{
      id: "33333333-3333-4333-8333-333333333333",
      caregiver_user_id: caregiverId,
      start_date: "2026-10-05",
      end_date: "2026-10-07",
      active: 1,
    }]);
    const parsed = parseRecurringScheduleMutation(body());
    if (!parsed.data) throw new Error(parsed.error);

    await expect(resolveRecurringScheduleMutation(parsed.data)).resolves.toMatchObject({
      error: expect.stringContaining("08/10/2026"),
    });
    expect(mocks.listCaregiverScheduleEntriesForProfessional).not.toHaveBeenCalled();
  });

  it("detecta conflitos com plantões existentes antes de qualquer gravação", async () => {
    mocks.listCaregiverScheduleEntriesForProfessional.mockResolvedValue([{
      id: "entry-existing",
      scheduled_date: "2026-10-05",
      start_time: "19:00",
      end_time: "22:00",
      ends_next_day: false,
    }]);
    const parsed = parseRecurringScheduleMutation(body());
    if (!parsed.data) throw new Error(parsed.error);

    await expect(resolveRecurringScheduleMutation(parsed.data)).resolves.toMatchObject({
      conflict: true,
      error: expect.stringContaining("outro plantão"),
    });
  });
});
