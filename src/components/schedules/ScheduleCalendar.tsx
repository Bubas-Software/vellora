"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { ProfessionalOption, ScheduleEntry, SchedulePatientOption } from "./types";
import { dateFromKey, dateKey, formatLongDate, formatMonth, formatShiftTime, formatTime, monthDays, PROFESSION_LABELS, timeToMinutes, WEEKDAYS } from "./date-utils";
import { generateScheduleRecurrence, type ScheduleRecurrencePattern } from "@/lib/schedule-recurrence";

type CalendarProps =
  | { mode: "admin"; patientId: string; patientName: string; canManagePayroll?: boolean }
  | { mode: "professional"; patients: SchedulePatientOption[] };

type ScheduleResponse = { entries?: ScheduleEntry[]; professionals?: ProfessionalOption[]; error?: string };

type ScheduleDraft = {
  caregiver_user_id: string;
  scheduled_date: string;
  start_time: string;
  end_time: string;
  ends_next_day: boolean;
  payroll_amount_override: string;
};

type RecurrenceDraft = {
  end_date: string;
  pattern: ScheduleRecurrencePattern;
  interval_days: number;
  weekdays: number[];
  dates: string[];
  skip_dates: string[];
  custom_date: string;
  skip_date: string;
};

const RECURRENCE_OPTIONS: { value: ScheduleRecurrencePattern; label: string }[] = [
  { value: "daily", label: "Todos os dias" },
  { value: "alternate_days", label: "Dia sim, dia não" },
  { value: "weekdays", label: "Segunda a sexta" },
  { value: "weekends", label: "Finais de semana" },
  { value: "selected_weekdays", label: "Dias escolhidos" },
  { value: "every_n_days", label: "A cada N dias" },
  { value: "monthly", label: "Mensal" },
  { value: "custom_dates", label: "Datas avulsas" },
];

function endDateAfterOneYear(startDate: string) {
  const date = dateFromKey(startDate);
  date.setDate(date.getDate() + 365);
  return dateKey(date);
}

function newRecurrenceDraft(startDate: string): RecurrenceDraft {
  return {
    end_date: endDateAfterOneYear(startDate),
    pattern: "daily",
    interval_days: 2,
    weekdays: [1, 2, 3, 4, 5],
    dates: [],
    skip_dates: [],
    custom_date: "",
    skip_date: "",
  };
}

const NO_PATIENTS: SchedulePatientOption[] = [];

function getErrorMessage(value: unknown, fallback: string) {
  if (value instanceof Error && value.message) return value.message;
  return fallback;
}

function capitalize(value: string) {
  return value.charAt(0).toLocaleUpperCase("pt-BR") + value.slice(1);
}

function shiftDisplayName(entry: ScheduleEntry, mode: CalendarProps["mode"], patientNames: Map<string, string>) {
  if (mode === "admin") return entry.professional_name || "Profissional escalado";
  return entry.patient_name || patientNames.get(entry.patient_id) || "Paciente";
}

function isProfessionalEligible(option: ProfessionalOption, scheduledDate: string) {
  return option.start_date <= scheduledDate && (!option.end_date || option.end_date >= scheduledDate);
}

export function ScheduleCalendar(props: CalendarProps) {
  const mode = props.mode;
  const patientId = props.mode === "admin" ? props.patientId : undefined;
  const patientName = props.mode === "admin" ? props.patientName : undefined;
  const canManagePayroll = props.mode === "admin" && props.canManagePayroll === true;
  const patients = props.mode === "professional" ? props.patients : NO_PATIENTS;
  const monthInputId = useId();
  const patientFilterId = useId();
  const recurrenceGroupId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [patientFilter, setPatientFilter] = useState("todos");
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [professionals, setProfessionals] = useState<ProfessionalOption[]>([]);
  const [loadedMonth, setLoadedMonth] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorMonth, setLoadErrorMonth] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [recurrenceEnabled, setRecurrenceEnabled] = useState(false);
  const [recurrenceDraft, setRecurrenceDraft] = useState<RecurrenceDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationMessage, setMutationMessage] = useState<string | null>(null);

  const patientNames = useMemo(() => new Map(patients.map((patient) => [patient.id, patient.name])), [patients]);

  const fetchSchedule = useCallback(async (signal?: AbortSignal) => {
      const params = new URLSearchParams({ month });
      if (mode === "admin" && patientId) params.set("patient_id", patientId);
      const response = await fetch(`/api/schedules?${params.toString()}`, {
        cache: "no-store",
        signal,
      });
      const payload = await response.json().catch(() => null) as ScheduleResponse | null;
      if (!response.ok) {
        if (mode === "admin" && patientId) {
          const rosterResponse = await fetch(`/api/admin/schedules/professionals?${params.toString()}`, {
            cache: "no-store",
            signal,
          });
          const roster = await rosterResponse.json().catch(() => null) as ScheduleResponse | null;
          if (rosterResponse.ok && roster && Array.isArray(roster.professionals)) {
            return {
              entries: [],
              professionals: roster.professionals,
              error: payload?.error || "Não foi possível carregar as escalas. Atualize a página e tente novamente.",
            };
          }
        }
        throw new Error(payload?.error || "Não foi possível carregar as escalas. Atualize a página e tente novamente.");
      }
      if (!payload || !Array.isArray(payload.entries)) {
        throw new Error("A resposta das escalas está incompleta. Atualize a página e tente novamente.");
      }
      return {
        entries: payload.entries,
        professionals: mode === "admin" && Array.isArray(payload.professionals) ? payload.professionals : [],
        error: undefined,
      };
  }, [mode, month, patientId]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSchedule(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setEntries(result.entries);
      setProfessionals(result.professionals);
      setLoadError(result.error || null);
      setLoadErrorMonth(result.error ? month : null);
      setLoadedMonth(month);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setEntries([]);
      setProfessionals([]);
      setLoadError(getErrorMessage(error, "Não foi possível carregar as escalas. Verifique a conexão e tente novamente."));
      setLoadErrorMonth(month);
      setLoadedMonth(month);
    });
    return () => controller.abort();
  }, [fetchSchedule, month]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (selectedDate && !dialog.open) dialog.showModal();
    if (!selectedDate && dialog.open) dialog.close();
  }, [selectedDate]);

  const dataReadyForMonth = loadedMonth === month && loadErrorMonth !== month && !retrying;
  const visibleEntries = useMemo(
    () => {
      const currentMonthEntries = dataReadyForMonth ? entries : [];
      return mode === "professional" && patientFilter !== "todos"
        ? currentMonthEntries.filter((entry) => entry.patient_id === patientFilter)
        : currentMonthEntries;
    },
    [dataReadyForMonth, entries, mode, patientFilter],
  );

  const entriesByDate = useMemo(() => {
    const grouped = new Map<string, ScheduleEntry[]>();
    for (const entry of visibleEntries) {
      const dateEntries = grouped.get(entry.scheduled_date) || [];
      dateEntries.push(entry);
      grouped.set(entry.scheduled_date, dateEntries);
    }
    for (const dateEntries of grouped.values()) {
      dateEntries.sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id));
    }
    return grouped;
  }, [visibleEntries]);

  const calendarDays = useMemo(() => monthDays(month), [month]);
  const selectedEntries = selectedDate ? entriesByDate.get(selectedDate) || [] : [];
  const loading = loadedMonth !== month || retrying;
  const visibleLoadError = loadErrorMonth === month ? loadError : null;
  const eligibleProfessionals = draft
    ? professionals.filter((professional) => isProfessionalEligible(professional, draft.scheduled_date))
    : [];
  const recurrencePreview = useMemo(() => {
    if (!recurrenceEnabled || !draft || !recurrenceDraft || editingId) return null;
    return generateScheduleRecurrence({
      start_date: draft.scheduled_date,
      end_date: recurrenceDraft.end_date,
      pattern: recurrenceDraft.pattern,
      interval_days: recurrenceDraft.interval_days,
      weekdays: recurrenceDraft.weekdays,
      dates: recurrenceDraft.dates,
      skip_dates: recurrenceDraft.skip_dates,
    });
  }, [draft, editingId, recurrenceDraft, recurrenceEnabled]);

  function changeMonth(value: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return;
    setSelectedDate(null);
    setDraft(null);
    setMonth(value);
  }

  function moveMonth(amount: number) {
    const [year, monthNumber] = month.split("-").map(Number);
    const target = new Date(year, monthNumber - 1 + amount, 1);
    changeMonth(`${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`);
  }

  async function refreshSchedule() {
    setRetrying(true);
    setLoadError(null);
    setLoadErrorMonth(null);
    try {
      const result = await fetchSchedule();
      setEntries(result.entries);
      setProfessionals(result.professionals);
      setLoadError(result.error || null);
      setLoadErrorMonth(result.error ? month : null);
      setLoadedMonth(month);
      return !result.error;
    } catch (error) {
      setEntries([]);
      setProfessionals([]);
      setLoadError(getErrorMessage(error, "Não foi possível carregar as escalas. Verifique a conexão e tente novamente."));
      setLoadErrorMonth(month);
      setLoadedMonth(month);
      return false;
    } finally {
      setRetrying(false);
    }
  }

  function clearDialogState() {
    setSelectedDate(null);
    setDraft(null);
    setRecurrenceEnabled(false);
    setRecurrenceDraft(null);
    setEditingId(null);
    setDeleteTargetId(null);
    setMutationError(null);
    setMutationMessage(null);
  }

  function closeDialog() {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    else clearDialogState();
  }

  function startCreate() {
    if (!selectedDate) return;
    setDraft({ caregiver_user_id: "", scheduled_date: selectedDate, start_time: "08:00", end_time: "20:00", ends_next_day: false, payroll_amount_override: "" });
    setRecurrenceEnabled(false);
    setRecurrenceDraft(newRecurrenceDraft(selectedDate));
    setEditingId(null);
    setDeleteTargetId(null);
    setMutationError(null);
    setMutationMessage(null);
  }

  function startEdit(entry: ScheduleEntry) {
    setDraft({
      caregiver_user_id: entry.caregiver_user_id,
      scheduled_date: entry.scheduled_date,
      start_time: formatTime(entry.start_time),
      end_time: formatTime(entry.end_time),
      ends_next_day: entry.ends_next_day,
      payroll_amount_override: entry.payroll_amount_override_cents
        ? (entry.payroll_amount_override_cents / 100).toFixed(2)
        : "",
    });
    setRecurrenceEnabled(false);
    setRecurrenceDraft(null);
    setEditingId(entry.id);
    setDeleteTargetId(null);
    setMutationError(null);
    setMutationMessage(null);
  }

  async function saveSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || mode !== "admin" || !patientId) return;
    setMutationError(null);
    setMutationMessage(null);

    const selectedProfessional = eligibleProfessionals.find((professional) => professional.user_id === draft.caregiver_user_id);
    const startMinutes = timeToMinutes(draft.start_time);
    const endMinutes = timeToMinutes(draft.end_time);

    if (!draft.scheduled_date) {
      setMutationError("Informe a data do plantão.");
      return;
    }
    if (!selectedProfessional) {
      setMutationError("Selecione um profissional vinculado e disponível na data escolhida.");
      return;
    }
    if (startMinutes === null || endMinutes === null) {
      setMutationError("Informe horários válidos entre 00:00 e 23:59.");
      return;
    }
    if (draft.ends_next_day && endMinutes > startMinutes) {
      setMutationError("Para terminar no dia seguinte, a hora final deve ser igual ou anterior à hora de início.");
      return;
    }
    if (!draft.ends_next_day && endMinutes <= startMinutes) {
      setMutationError("A hora de término precisa ser posterior à hora de início. Para terminar no dia seguinte, marque essa opção.");
      return;
    }
    if (recurrenceEnabled && !editingId && recurrencePreview && "error" in recurrencePreview) {
      setMutationError(recurrencePreview.error);
      return;
    }

    const payload = {
      patient_id: patientId,
      caregiver_user_id: draft.caregiver_user_id,
      start_time: draft.start_time,
      end_time: draft.end_time,
      ends_next_day: draft.ends_next_day,
    };
    const isRecurring = recurrenceEnabled && !editingId && recurrenceDraft !== null;
    const requestPayload = isRecurring
      ? {
          ...payload,
          start_date: draft.scheduled_date,
          end_date: recurrenceDraft.end_date,
          pattern: recurrenceDraft.pattern,
          interval_days: recurrenceDraft.interval_days,
          weekdays: recurrenceDraft.weekdays,
          dates: recurrenceDraft.dates,
          skip_dates: recurrenceDraft.skip_dates,
        }
      : {
          ...payload,
          scheduled_date: draft.scheduled_date,
          ...(canManagePayroll ? { payroll_amount_override: draft.payroll_amount_override } : {}),
        };

    setSaving(true);
    try {
      const response = await fetch(
        editingId
          ? `/api/admin/schedules/${encodeURIComponent(editingId)}`
          : isRecurring
            ? "/api/admin/schedules/recurring"
            : "/api/admin/schedules",
        {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
        },
      );
      const result = await response.json().catch(() => null) as { error?: string; created_count?: number } | null;
      if (!response.ok) throw new Error(result?.error || "Não foi possível salvar a escala. Verifique os dados e tente novamente.");

      const refreshed = await refreshSchedule();
      setDraft(null);
      setRecurrenceEnabled(false);
      setRecurrenceDraft(null);
      setEditingId(null);
      setDeleteTargetId(null);
      const successMessage = isRecurring && result?.created_count
        ? `${result.created_count} ${result.created_count === 1 ? "plantão recorrente foi aplicado" : "plantões recorrentes foram aplicados"}.`
        : "Escala salva com sucesso.";
      setMutationMessage(refreshed ? successMessage : `${successMessage} Atualize a página para carregar os dados mais recentes.`);
    } catch (error) {
      setMutationError(getErrorMessage(error, "Não foi possível salvar a escala. Verifique a conexão e tente novamente."));
    } finally {
      setSaving(false);
    }
  }

  async function deleteSchedule(entry: ScheduleEntry) {
    setMutationError(null);
    setMutationMessage(null);
    setSaving(true);
    try {
      const response = await fetch(`/api/admin/schedules/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error || "Não foi possível remover a escala. Tente novamente.");
      const refreshed = await refreshSchedule();
      setDeleteTargetId(null);
      setMutationMessage(refreshed ? "Escala removida." : "Escala removida. Atualize a página para carregar os dados mais recentes.");
    } catch (error) {
      setMutationError(getErrorMessage(error, "Não foi possível remover a escala. Verifique a conexão e tente novamente."));
    } finally {
      setSaving(false);
    }
  }

  function openDay(date: string) {
    setMutationError(null);
    setMutationMessage(null);
    setDraft(null);
    setEditingId(null);
    setDeleteTargetId(null);
    setSelectedDate(date);
  }

  return (
    <section className="space-y-4" aria-label={mode === "admin" ? `Calendário de escalas de ${patientName}` : "Calendário das minhas escalas"}>
      <div className="flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:flex-row sm:items-end sm:justify-between sm:p-5">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--foreground)]">Mês de consulta</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => moveMonth(-1)} aria-label="Ver mês anterior" className="min-h-11 min-w-11 rounded-xl border border-[var(--border)] bg-white text-lg text-[var(--brand)] hover:bg-[var(--brand-light)]">‹</button>
            <button type="button" onClick={() => moveMonth(1)} aria-label="Ver próximo mês" className="min-h-11 min-w-11 rounded-xl border border-[var(--border)] bg-white text-lg text-[var(--brand)] hover:bg-[var(--brand-light)]">›</button>
            <button type="button" onClick={() => changeMonth((() => {
              const now = new Date();
              return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
            })())} className="min-h-11 rounded-xl border border-[var(--border)] bg-white px-3 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--brand-light)]">
              Mês atual
            </button>
            <label htmlFor={monthInputId} className="sr-only">Selecionar mês</label>
            <input
              id={monthInputId}
              type="month"
              value={month}
              onChange={(event) => changeMonth(event.target.value)}
              className="min-h-11 min-w-0 rounded-xl border border-[var(--border-strong)] bg-white px-3 text-sm text-[var(--foreground)]"
            />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-1 sm:items-end">
          <p className="text-xl font-semibold text-[var(--foreground)]">{formatMonth(month)}</p>
          {mode === "professional" && patients.length > 1 && (
            <div className="w-full sm:w-auto">
              <label htmlFor={patientFilterId} className="sr-only">Filtrar escalas por paciente</label>
              <select
                id={patientFilterId}
                value={patientFilter}
                onChange={(event) => setPatientFilter(event.target.value)}
                className="min-h-11 w-full rounded-xl border border-[var(--border-strong)] bg-white px-3 text-sm text-[var(--foreground)] sm:max-w-xs"
              >
                <option value="todos">Todos os meus pacientes</option>
                {patients.map((patient) => <option key={patient.id} value={patient.id}>{patient.name}</option>)}
              </select>
            </div>
          )}
        </div>
      </div>

      {visibleLoadError && (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-[var(--status-critical)]/30 bg-[var(--status-critical-bg)] p-4 text-sm text-[var(--status-critical)] sm:flex-row sm:items-center sm:justify-between">
          <p>{visibleLoadError}</p>
          <button type="button" onClick={() => void refreshSchedule()} className="min-h-11 shrink-0 rounded-lg border border-[var(--status-critical)]/30 bg-white px-4 font-semibold hover:bg-[var(--status-critical-bg)]">Tentar novamente</button>
        </div>
      )}

      <p role="status" aria-live="polite" className="min-h-5 text-sm text-[var(--muted)]">
        {loading ? "Carregando escalas…" : `${visibleEntries.length} ${visibleEntries.length === 1 ? "plantão neste mês" : "plantões neste mês"}`}
      </p>

      <div className="overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)]">
        <table className="w-full table-fixed border-collapse" aria-label={`Calendário mensal de escalas: ${formatMonth(month)}`}>
          <thead>
            <tr>
              {WEEKDAYS.map((weekday) => (
                <th key={weekday} scope="col" className="border-b border-r border-[var(--border)] bg-[var(--surface-soft)] px-0.5 py-2 text-center text-[0.62rem] font-semibold text-[var(--muted)] last:border-r-0 sm:px-2 sm:py-3 sm:text-xs">
                  <span className="sm:hidden" aria-hidden="true">{weekday.slice(0, 1)}</span>
                  <span className="hidden sm:inline">{weekday}</span>
                  <span className="sr-only sm:hidden">{weekday}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }, (_, weekIndex) => (
              <tr key={weekIndex}>
                {calendarDays.slice(weekIndex * 7, weekIndex * 7 + 7).map(({ date, key, inMonth }) => {
                  const dayEntries = entriesByDate.get(key) || [];
                  const firstName = dayEntries[0] ? shiftDisplayName(dayEntries[0], mode, patientNames) : "";
                  const isToday = key === dateKey(new Date());
                  const spokenLabel = `${formatLongDate(key)}${dayEntries.length ? `, ${dayEntries.length} ${dayEntries.length === 1 ? "plantão" : "plantões"}${firstName ? `, ${mode === "admin" ? "profissional" : "paciente"}: ${firstName}` : ""}` : ", sem plantões"}`;
                  return (
                    <td key={key} className={`h-[4.65rem] border-b border-r border-[var(--border)] p-0 align-top last:border-r-0 sm:h-28 ${weekIndex === 5 ? "border-b-0" : ""} ${inMonth ? "bg-white" : "bg-[var(--surface-soft)]/70"}`}>
                      {inMonth ? (
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => openDay(key)}
                          aria-label={spokenLabel}
                          aria-current={isToday ? "date" : undefined}
                          className={`flex h-full min-h-[4.65rem] w-full flex-col items-stretch gap-0.5 overflow-hidden p-1 text-left hover:bg-[var(--brand-light)] disabled:cursor-wait disabled:opacity-70 sm:min-h-28 sm:gap-1 sm:p-2 ${selectedDate === key ? "bg-[var(--brand-light)]" : ""}`}
                        >
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-medium sm:h-6 sm:w-6 sm:text-xs ${isToday ? "bg-[var(--brand)] text-white" : "text-[var(--foreground)]"}`}>
                            {date.getDate()}
                          </span>
                          {dayEntries.length > 0 && (
                            <span title={firstName} className="block max-w-full truncate rounded-md bg-[var(--brand-light)] px-1 py-0.5 text-[0.55rem] font-medium leading-tight text-[var(--brand-dark)] sm:px-1.5 sm:text-[0.68rem]">
                              {mode === "professional" && <span className="sm:hidden">{formatTime(dayEntries[0].start_time)} </span>}
                              {firstName}
                              {mode === "admin" && <span className="hidden sm:inline"> · {formatTime(dayEntries[0].start_time)}</span>}
                            </span>
                          )}
                          {dayEntries.length > 1 && (
                            <span className="truncate pl-1 text-[0.55rem] font-semibold text-[var(--muted)] sm:text-[0.65rem]">
                              +{dayEntries.length - 1} {mode === "admin" ? "profissional" : "plantão"}{dayEntries.length > 2 ? "s" : ""}
                            </span>
                          )}
                        </button>
                      ) : (
                        <span aria-hidden="true" className="flex h-full min-h-[4.65rem] items-start p-1 text-[0.65rem] text-[var(--muted-2)] sm:min-h-28 sm:p-2 sm:text-xs">
                          {date.getDate()}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!loading && visibleEntries.length === 0 && !visibleLoadError && (
        <p className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface)] p-4 text-sm text-[var(--muted)]">
          {mode === "admin"
            ? "Nenhum profissional está escalado neste mês. Selecione um dia no calendário para consultar ou adicionar um plantão."
            : "Nenhum plantão aparece neste mês. Se esperava encontrar uma escala, fale com a administração."}
        </p>
      )}

      <dialog
        ref={dialogRef}
        aria-labelledby="schedule-day-title"
        onClose={clearDialogState}
        onClick={(event) => { if (event.target === event.currentTarget) closeDialog(); }}
        className="m-auto max-h-[calc(100dvh-1.5rem)] w-[calc(100%-1.5rem)] max-w-2xl overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--foreground)] shadow-2xl backdrop:bg-black/45"
      >
        {selectedDate && (
          <div className="p-4 sm:p-6">
            <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] pb-4">
              <div className="min-w-0">
                <p className="eyebrow">{mode === "admin" ? "Escala do dia" : "Meus plantões"}</p>
                <h3 id="schedule-day-title" className="mt-1 break-words text-lg font-semibold sm:text-xl">{capitalize(formatLongDate(selectedDate))}</h3>
              </div>
              <button type="button" onClick={closeDialog} className="min-h-11 shrink-0 rounded-xl border border-[var(--border)] px-3 text-sm font-medium text-[var(--muted)] hover:bg-[var(--surface-soft)]">
                Fechar
              </button>
            </header>

            {mode === "admin" ? (
              <div className="mt-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h4 className="text-base font-semibold">Profissionais escalados</h4>
                  {!draft && (
                    <button type="button" onClick={startCreate} disabled={saving} className="min-h-11 rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-white hover:bg-[var(--brand-dark)] disabled:opacity-60">
                      Adicionar profissional
                    </button>
                  )}
                </div>

                {selectedEntries.length === 0 && !draft && (
                  <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-4 text-sm text-[var(--muted)]">
                    Nenhum profissional escalado para esta data. Você pode adicionar um plantão.
                  </p>
                )}

                {selectedEntries.map((entry) => (
                  <article key={entry.id} className="rounded-xl border border-[var(--border)] bg-white p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <h5 className="break-words font-semibold text-[var(--foreground)]">{entry.professional_name || "Profissional"}</h5>
                        <p className="mt-1 text-sm text-[var(--muted)]">Função: {PROFESSION_LABELS[entry.profession] || "Profissional"}</p>
                        <p className="text-sm text-[var(--muted)]">Horário: {formatShiftTime(entry)}</p>
                        {mode === "admin" && entry.payroll_rate_status === "valor_pendente" && (
                          <p className="mt-2 inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900">
                            Valor pendente
                          </p>
                        )}
                        {entry.professional_phone && (
                          <a href={`tel:${entry.professional_phone.replace(/[^\d+]/g, "")}`} className="mt-1 inline-flex min-h-10 items-center text-sm font-medium text-[var(--brand)] underline underline-offset-2">
                            Telefone: {entry.professional_phone}
                          </a>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => startEdit(entry)} disabled={saving} className="min-h-10 rounded-lg border border-[var(--border-strong)] px-3 text-sm font-medium text-[var(--brand)] hover:bg-[var(--brand-light)] disabled:opacity-60">
                          Editar escala
                        </button>
                        <button type="button" onClick={() => { setDeleteTargetId(entry.id); setDraft(null); setEditingId(null); setMutationError(null); setMutationMessage(null); }} disabled={saving} className="min-h-10 rounded-lg border border-[var(--status-critical)]/40 px-3 text-sm font-medium text-[var(--status-critical)] hover:bg-[var(--status-critical-bg)] disabled:opacity-60">
                          Remover da escala
                        </button>
                      </div>
                    </div>
                    {deleteTargetId === entry.id && (
                      <div className="mt-4 rounded-lg border border-[var(--status-critical)]/30 bg-[var(--status-critical-bg)] p-3" role="group" aria-label={`Confirmação para remover ${entry.professional_name || "profissional"} da escala`}>
                        <p className="text-sm font-medium text-[var(--foreground)]">Remover este plantão da escala?</p>
                        <p className="mt-1 text-sm text-[var(--muted)]">A ação excluirá este horário deste paciente.</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button type="button" onClick={() => void deleteSchedule(entry)} disabled={saving} className="min-h-10 rounded-lg bg-[var(--status-critical)] px-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
                            {saving ? "Removendo…" : "Excluir plantão"}
                          </button>
                          <button type="button" onClick={() => setDeleteTargetId(null)} disabled={saving} className="min-h-10 rounded-lg border border-[var(--border-strong)] bg-white px-3 text-sm font-medium text-[var(--foreground)] disabled:opacity-60">
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                ))}

                {draft && (
                  <form onSubmit={saveSchedule} className="space-y-4 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-soft)] p-4" noValidate>
                    <h5 className="font-semibold">{editingId ? "Editar plantão" : "Novo plantão"}</h5>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="text-sm font-medium text-[var(--foreground)] sm:col-span-2">
                        Profissional
                        <select
                          required
                          value={eligibleProfessionals.some((professional) => professional.user_id === draft.caregiver_user_id) ? draft.caregiver_user_id : ""}
                          onChange={(event) => setDraft((current) => current ? { ...current, caregiver_user_id: event.target.value } : current)}
                          className="mt-1.5 min-h-11 w-full rounded-xl border border-[var(--border-strong)] bg-white px-3 text-sm"
                        >
                          <option value="">Selecione um profissional</option>
                          {eligibleProfessionals.map((professional) => (
                            <option key={professional.user_id} value={professional.user_id}>
                              {professional.name} · {PROFESSION_LABELS[professional.profession]}
                            </option>
                          ))}
                        </select>
                        {eligibleProfessionals.length === 0 && (
                          <span className="mt-1 block text-xs font-normal text-[var(--muted)]">
                            Não há profissional com vínculo válido nesta data. Verifique as datas do vínculo antes de editar a escala.
                          </span>
                        )}
                      </label>
                      <label className="text-sm font-medium text-[var(--foreground)]">
                        {recurrenceEnabled && !editingId ? "Data inicial" : "Data"}
                        <input
                          type="date"
                          required
                          value={draft.scheduled_date}
                          onChange={(event) => {
                            const nextStartDate = event.target.value;
                            setDraft((current) => current ? { ...current, scheduled_date: nextStartDate } : current);
                            setRecurrenceDraft((current) => current && current.end_date < nextStartDate
                              ? { ...current, end_date: endDateAfterOneYear(nextStartDate) }
                              : current);
                          }}
                          className="mt-1.5 min-h-11 w-full rounded-xl border border-[var(--border-strong)] bg-white px-3 text-sm"
                        />
                      </label>
                      <label className="text-sm font-medium text-[var(--foreground)]">
                        Hora de início
                        <input
                          type="time"
                          required
                          value={draft.start_time}
                          onChange={(event) => setDraft((current) => current ? { ...current, start_time: event.target.value } : current)}
                          className="mt-1.5 min-h-11 w-full rounded-xl border border-[var(--border-strong)] bg-white px-3 text-sm"
                        />
                      </label>
                      <label className="text-sm font-medium text-[var(--foreground)] sm:col-span-2">
                        Hora de término
                        <input
                          type="time"
                          required
                          value={draft.end_time}
                          onChange={(event) => setDraft((current) => current ? { ...current, end_time: event.target.value } : current)}
                          className="mt-1.5 min-h-11 w-full rounded-xl border border-[var(--border-strong)] bg-white px-3 text-sm sm:max-w-xs"
                        />
                      </label>
                    </div>
                    <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--foreground)]">
                      <input
                        type="checkbox"
                        checked={draft.ends_next_day}
                        onChange={(event) => setDraft((current) => current ? { ...current, ends_next_day: event.target.checked } : current)}
                        className="h-4 w-4 accent-[var(--brand)]"
                      />
                      O horário termina no dia seguinte
                    </label>
                    {canManagePayroll && (!recurrenceEnabled || Boolean(editingId)) && (
                      <label className="block text-sm font-medium text-[var(--foreground)]">
                        Valor deste plantão, se diferente do padrão da família (R$)
                        <input
                          type="number"
                          min="0.01"
                          max="1000000"
                          step="0.01"
                          inputMode="decimal"
                          value={draft.payroll_amount_override}
                          onChange={(event) => setDraft((current) => current
                            ? { ...current, payroll_amount_override: event.target.value }
                            : current)}
                          placeholder="Informe somente se houver exceção"
                          className="mt-1.5 min-h-11 w-full rounded-xl border border-[var(--border-strong)] bg-white px-3 text-sm sm:max-w-xs"
                          disabled={saving}
                          aria-describedby="schedule-payroll-override-help"
                        />
                        <span id="schedule-payroll-override-help" className="mt-1.5 block text-xs font-normal text-[var(--muted)]">
                          Preencha somente se este plantão tiver valor diferente do serviço definido para o paciente na família. Em branco, o valor da família é mantido. A exceção vale só para esta escala e atualiza o Financeiro.
                        </span>
                      </label>
                    )}
                    {!editingId && (
                      <section className="space-y-3 rounded-xl border border-[var(--border)] bg-white p-3 sm:p-4" aria-label="Recorrência do plantão">
                        <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-[var(--foreground)]">
                          <input
                            type="checkbox"
                            checked={recurrenceEnabled}
                            onChange={(event) => setRecurrenceEnabled(event.target.checked)}
                            className="h-4 w-4 accent-[var(--brand)]"
                          />
                          Repetir este plantão
                        </label>
                        {recurrenceEnabled && recurrenceDraft && (
                          <div className="space-y-4 border-t border-[var(--border)] pt-4">
                            <p className="text-sm text-[var(--muted)]">
                              Escolha o padrão e confira as datas antes de aplicar. Cada ocorrência será criada como um plantão separado.
                            </p>
                            <label className="block text-sm font-medium text-[var(--foreground)]">
                              Data final
                              <input
                                type="date"
                                required
                                min={draft.scheduled_date}
                                value={recurrenceDraft.end_date}
                                onChange={(event) => setRecurrenceDraft((current) => current ? { ...current, end_date: event.target.value } : current)}
                                className="mt-1.5 min-h-11 w-full rounded-xl border border-[var(--border-strong)] bg-white px-3 text-base sm:max-w-xs sm:text-sm"
                              />
                            </label>

                            <fieldset className="space-y-2">
                              <legend className="text-sm font-medium text-[var(--foreground)]">Como repetir?</legend>
                              <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 sm:grid-cols-4">
                                {RECURRENCE_OPTIONS.map((option) => (
                                  <label
                                    key={option.value}
                                    className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm leading-snug ${recurrenceDraft.pattern === option.value ? "border-[var(--brand)] bg-[var(--brand-light)] text-[var(--brand-dark)]" : "border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)]"}`}
                                  >
                                    <input
                                      type="radio"
                                      name={`schedule-pattern-${recurrenceGroupId}`}
                                      value={option.value}
                                      checked={recurrenceDraft.pattern === option.value}
                                      onChange={() => setRecurrenceDraft((current) => current ? { ...current, pattern: option.value } : current)}
                                      className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
                                    />
                                    <span>{option.label}</span>
                                  </label>
                                ))}
                              </div>
                            </fieldset>

                            {recurrenceDraft.pattern === "selected_weekdays" && (
                              <fieldset className="space-y-2">
                                <legend className="text-sm font-medium text-[var(--foreground)]">Dias da semana</legend>
                                <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                                  {WEEKDAYS.map((weekday, index) => (
                                    <label key={weekday} className="flex min-h-11 items-center gap-2 rounded-lg border border-[var(--border)] px-2 text-sm text-[var(--foreground)]">
                                      <input
                                        type="checkbox"
                                        checked={recurrenceDraft.weekdays.includes(index)}
                                        onChange={(event) => setRecurrenceDraft((current) => {
                                          if (!current) return current;
                                          const weekdays = event.target.checked
                                            ? [...current.weekdays, index].sort((a, b) => a - b)
                                            : current.weekdays.filter((day) => day !== index);
                                          return { ...current, weekdays };
                                        })}
                                        className="h-4 w-4 accent-[var(--brand)]"
                                      />
                                      {weekday}
                                    </label>
                                  ))}
                                </div>
                              </fieldset>
                            )}

                            {recurrenceDraft.pattern === "every_n_days" && (
                              <label className="block text-sm font-medium text-[var(--foreground)]">
                                Repetir a cada quantos dias?
                                <input
                                  type="number"
                                  min={1}
                                  max={366}
                                  step={1}
                                  value={recurrenceDraft.interval_days}
                                  onChange={(event) => setRecurrenceDraft((current) => current ? { ...current, interval_days: Number(event.target.value) } : current)}
                                  className="mt-1.5 min-h-11 w-full rounded-xl border border-[var(--border-strong)] bg-white px-3 text-base sm:max-w-xs sm:text-sm"
                                />
                              </label>
                            )}

                            {recurrenceDraft.pattern === "custom_dates" && (
                              <fieldset className="space-y-2">
                                <legend className="text-sm font-medium text-[var(--foreground)]">Datas dos plantões</legend>
                                <div className="flex flex-col gap-2 min-[420px]:flex-row">
                                  <input
                                    type="date"
                                    aria-label="Data avulsa"
                                    value={recurrenceDraft.custom_date}
                                    onChange={(event) => setRecurrenceDraft((current) => current ? { ...current, custom_date: event.target.value } : current)}
                                    className="min-h-11 min-w-0 flex-1 rounded-xl border border-[var(--border-strong)] bg-white px-3 text-base sm:text-sm"
                                  />
                                  <button
                                    type="button"
                                    disabled={!recurrenceDraft.custom_date || recurrenceDraft.dates.includes(recurrenceDraft.custom_date)}
                                    onClick={() => setRecurrenceDraft((current) => current ? {
                                      ...current,
                                      dates: [...current.dates, current.custom_date].sort(),
                                      custom_date: "",
                                    } : current)}
                                    className="min-h-11 rounded-xl border border-[var(--border-strong)] px-3 text-sm font-medium text-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    Adicionar data
                                  </button>
                                </div>
                                {recurrenceDraft.dates.length > 0 && (
                                  <ul className="flex flex-wrap gap-2" aria-label="Datas avulsas selecionadas">
                                    {recurrenceDraft.dates.map((date) => (
                                      <li key={date}>
                                        <button
                                          type="button"
                                          onClick={() => setRecurrenceDraft((current) => current ? { ...current, dates: current.dates.filter((item) => item !== date) } : current)}
                                          aria-label={`Remover data ${formatLongDate(date)} das datas avulsas`}
                                          className="min-h-10 rounded-lg border border-[var(--border)] bg-[var(--surface-soft)] px-3 text-sm text-[var(--foreground)] hover:bg-[var(--brand-light)]"
                                        >
                                          {formatLongDate(date)} ×
                                        </button>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </fieldset>
                            )}

                            <fieldset className="space-y-2">
                              <legend className="text-sm font-medium text-[var(--foreground)]">Datas para pular (opcional)</legend>
                              <p className="text-xs text-[var(--muted)]">Use para folgas, feriados ou exceções do vínculo.</p>
                              <div className="flex flex-col gap-2 min-[420px]:flex-row">
                                <input
                                  type="date"
                                  aria-label="Data para pular"
                                  value={recurrenceDraft.skip_date}
                                  onChange={(event) => setRecurrenceDraft((current) => current ? { ...current, skip_date: event.target.value } : current)}
                                  className="min-h-11 min-w-0 flex-1 rounded-xl border border-[var(--border-strong)] bg-white px-3 text-base sm:text-sm"
                                />
                                <button
                                  type="button"
                                  disabled={!recurrenceDraft.skip_date || recurrenceDraft.skip_dates.includes(recurrenceDraft.skip_date)}
                                  onClick={() => setRecurrenceDraft((current) => current ? {
                                    ...current,
                                    skip_dates: [...current.skip_dates, current.skip_date].sort(),
                                    skip_date: "",
                                  } : current)}
                                  className="min-h-11 rounded-xl border border-[var(--border-strong)] px-3 text-sm font-medium text-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  Pular data
                                </button>
                              </div>
                              {recurrenceDraft.skip_dates.length > 0 && (
                                <ul className="flex flex-wrap gap-2" aria-label="Datas para pular selecionadas">
                                  {recurrenceDraft.skip_dates.map((date) => (
                                    <li key={date}>
                                      <button
                                        type="button"
                                        onClick={() => setRecurrenceDraft((current) => current ? { ...current, skip_dates: current.skip_dates.filter((item) => item !== date) } : current)}
                                        aria-label={`Remover data ${formatLongDate(date)} das exceções`}
                                        className="min-h-10 rounded-lg border border-[var(--border)] bg-[var(--surface-soft)] px-3 text-sm text-[var(--foreground)] hover:bg-[var(--brand-light)]"
                                      >
                                        {formatLongDate(date)} ×
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </fieldset>

                            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-soft)] p-3 text-sm" role="status" aria-live="polite">
                              <h6 className="font-semibold text-[var(--foreground)]">Prévia da recorrência</h6>
                              {recurrencePreview && "error" in recurrencePreview ? (
                                <p className="mt-1 text-[var(--status-critical)]">{recurrencePreview.error}</p>
                              ) : recurrencePreview && "dates" in recurrencePreview ? (
                                <>
                                  <p className="mt-1 font-medium text-[var(--foreground)]">
                                    {recurrencePreview.dates.length} {recurrencePreview.dates.length === 1 ? "plantão" : "plantões"} serão adicionados.
                                  </p>
                                  <p className="mt-1 text-[var(--muted)]">
                                    Próximas datas: {recurrencePreview.dates.slice(0, 5).map(formatLongDate).join(" · ")}
                                    {recurrencePreview.dates.length > 5 ? " · …" : ""}
                                  </p>
                                </>
                              ) : null}
                            </div>
                          </div>
                        )}
                      </section>
                    )}
                    {mutationError && <p role="alert" className="rounded-lg bg-[var(--status-critical-bg)] p-3 text-sm text-[var(--status-critical)]">{mutationError}</p>}
                    <div className="flex flex-wrap gap-2">
                      <button type="submit" disabled={saving} className="min-h-11 rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-white hover:bg-[var(--brand-dark)] disabled:cursor-wait disabled:opacity-60">
                        {saving ? "Salvando…" : editingId ? "Salvar alterações" : recurrenceEnabled ? "Aplicar recorrência" : "Adicionar à escala"}
                      </button>
                      <button type="button" disabled={saving} onClick={() => { setDraft(null); setEditingId(null); setMutationError(null); }} className="min-h-11 rounded-xl border border-[var(--border-strong)] bg-white px-4 text-sm font-medium text-[var(--foreground)] disabled:opacity-60">
                        Cancelar
                      </button>
                    </div>
                  </form>
                )}

                {mutationMessage && <p role="status" aria-live="polite" className="rounded-lg bg-[var(--accent-light)] p-3 text-sm font-medium text-[var(--accent-dark)]">{mutationMessage}</p>}
                {mutationError && !draft && <p role="alert" className="rounded-lg bg-[var(--status-critical-bg)] p-3 text-sm text-[var(--status-critical)]">{mutationError}</p>}
              </div>
            ) : (
              <div className="mt-5 space-y-3">
                {selectedEntries.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-4 text-sm text-[var(--muted)]">
                    Nenhum plantão seu está registrado para esta data.
                  </p>
                ) : selectedEntries.map((entry) => {
                  const ownPatientName = entry.patient_name || patientNames.get(entry.patient_id) || "Paciente";
                  return (
                    <article key={entry.id} className="rounded-xl border border-[var(--border)] bg-white p-4">
                      <h4 className="break-words font-semibold text-[var(--foreground)]">{ownPatientName}</h4>
                      <p className="mt-1 text-sm text-[var(--muted)]">Horário: {formatShiftTime(entry)}</p>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </dialog>
    </section>
  );
}
