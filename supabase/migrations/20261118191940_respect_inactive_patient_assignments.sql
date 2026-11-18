begin;

-- Cancel payroll for future shifts when the patient is deactivated or the
-- caregiver assignment ends. Keep completed shifts, paid expenses, and manual
-- payroll adjustments intact.
create or replace function private.sync_caregiver_schedule_payroll(target_schedule_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  shift_date date;
  schedule_created_by uuid;
  target_caregiver_user_id uuid;
  caregiver_name text;
  patient_name text;
  patient_status text;
  assignment_active boolean;
  assignment_end_date date;
  shift_rate_cents integer;
  has_manual_or_paid_expense boolean;
  local_today date := pg_catalog.timezone('America/Sao_Paulo', pg_catalog.statement_timestamp())::date;
  shift_cancelled boolean;
begin
  select entry.scheduled_date,
         entry.created_by,
         assignment.caregiver_user_id,
         assignment.active,
         assignment.end_date,
         patient.status,
         coalesce(caregiver.name, 'Profissional'),
         coalesce(patient.name, 'Paciente'),
         coalesce(entry.payroll_amount_override_cents, rate.amount_cents)
    into shift_date,
         schedule_created_by,
         target_caregiver_user_id,
         assignment_active,
         assignment_end_date,
         patient_status,
         caregiver_name,
         patient_name,
         shift_rate_cents
    from public.caregiver_schedule_entries as entry
    join public.caregiver_assignments as assignment
      on assignment.id = entry.caregiver_assignment_id
    left join public.patients as patient
      on patient.id = assignment.patient_id
    left join public.caregiver_profiles as caregiver
      on caregiver.user_id = assignment.caregiver_user_id
    left join lateral (
      select configured_rate.amount_cents
      from public.family_patient_service_rates as configured_rate
      where configured_rate.family_user_id = patient.family_user_id
        and configured_rate.patient_id = patient.id
        and configured_rate.profession = entry.profession
        and entry.scheduled_date between configured_rate.valid_from and coalesce(configured_rate.valid_to, 'infinity'::date)
      order by configured_rate.valid_from desc
      limit 1
    ) as rate on true
    where entry.id = target_schedule_entry_id;

  if not found then
    delete from public.finance_expenses as expense
    where expense.caregiver_schedule_entry_id = target_schedule_entry_id
      and expense.paid_on is null
      and not expense.caregiver_payroll_amount_overridden;
    return;
  end if;

  shift_cancelled := shift_date > local_today and (
    not assignment_active
    or (assignment_end_date is not null and shift_date > assignment_end_date)
    or patient_status = 'inativo'
  );

  if shift_cancelled then
    delete from public.finance_expenses as expense
    where expense.caregiver_schedule_entry_id = target_schedule_entry_id
      and expense.paid_on is null
      and not expense.caregiver_payroll_amount_overridden;

    update public.caregiver_schedule_entries
    set payroll_rate_status = case when exists (
      select 1
      from public.finance_expenses as expense
      where expense.caregiver_schedule_entry_id = target_schedule_entry_id
    ) then 'gerado' else 'valor_pendente' end
    where id = target_schedule_entry_id;
    return;
  end if;

  select exists (
    select 1
    from public.finance_expenses as expense
    where expense.caregiver_schedule_entry_id = target_schedule_entry_id
      and (expense.paid_on is not null or expense.caregiver_payroll_amount_overridden)
  ) into has_manual_or_paid_expense;

  update public.caregiver_schedule_entries
  set payroll_rate_status = case
    when (shift_rate_cents is not null and shift_rate_cents > 0) or has_manual_or_paid_expense then 'gerado'
    else 'valor_pendente'
  end
  where id = target_schedule_entry_id;

  if shift_rate_cents is null or shift_rate_cents <= 0 then
    delete from public.finance_expenses as expense
    where expense.caregiver_schedule_entry_id = target_schedule_entry_id
      and expense.paid_on is null
      and not expense.caregiver_payroll_amount_overridden;
    return;
  end if;

  insert into public.finance_expenses (
    expense_date,
    category,
    description,
    amount_cents,
    paid_on,
    caregiver_schedule_entry_id,
    caregiver_user_id,
    payee,
    created_by
  ) values (
    shift_date,
    'equipe',
    'Plantão — ' || caregiver_name || ' · ' || patient_name,
    shift_rate_cents,
    null,
    target_schedule_entry_id,
    target_caregiver_user_id,
    caregiver_name,
    schedule_created_by
  )
  on conflict (caregiver_schedule_entry_id) do update
    set expense_date = excluded.expense_date,
        description = excluded.description,
        amount_cents = case
          when finance_expenses.caregiver_payroll_amount_overridden then finance_expenses.amount_cents
          else excluded.amount_cents
        end,
        caregiver_user_id = excluded.caregiver_user_id,
        payee = excluded.payee,
        updated_at = pg_catalog.now()
    where finance_expenses.paid_on is null;
end;
$$;

create or replace function private.sync_caregiver_assignment_payroll()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  local_today date := pg_catalog.timezone('America/Sao_Paulo', pg_catalog.statement_timestamp())::date;
  schedule_row record;
begin
  for schedule_row in
    select entry.id
    from public.caregiver_schedule_entries as entry
    where entry.caregiver_assignment_id = new.id
      and entry.scheduled_date > local_today
  loop
    perform private.sync_caregiver_schedule_payroll(schedule_row.id);
  end loop;
  return new;
end;
$$;

create or replace function private.sync_patient_schedule_payroll()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  local_today date := pg_catalog.timezone('America/Sao_Paulo', pg_catalog.statement_timestamp())::date;
  schedule_row record;
begin
  for schedule_row in
    select entry.id
    from public.caregiver_schedule_entries as entry
    join public.caregiver_assignments as assignment
      on assignment.id = entry.caregiver_assignment_id
    where assignment.patient_id = new.id
      and (
        entry.scheduled_date > local_today
      )
  loop
    perform private.sync_caregiver_schedule_payroll(schedule_row.id);
  end loop;
  return new;
end;
$$;

drop trigger if exists caregiver_assignments_sync_payroll on public.caregiver_assignments;
create trigger caregiver_assignments_sync_payroll
after update of caregiver_user_id, active, end_date on public.caregiver_assignments
for each row execute function private.sync_caregiver_assignment_payroll();

drop trigger if exists patients_sync_schedule_payroll on public.patients;
create trigger patients_sync_schedule_payroll
after update of status on public.patients
for each row
when (old.status is distinct from new.status)
execute function private.sync_patient_schedule_payroll();

revoke all on function private.sync_caregiver_schedule_payroll(uuid) from public, anon, authenticated;
revoke all on function private.sync_caregiver_assignment_payroll() from public, anon, authenticated;
revoke all on function private.sync_patient_schedule_payroll() from public, anon, authenticated;
grant execute on function private.sync_caregiver_schedule_payroll(uuid) to service_role;
grant execute on function private.sync_caregiver_assignment_payroll() to service_role;
grant execute on function private.sync_patient_schedule_payroll() to service_role;

-- Reconcile unpaid, automatically generated expenses that were left behind
-- before these lifecycle triggers existed.
do $$
declare
  local_today date := pg_catalog.timezone('America/Sao_Paulo', pg_catalog.statement_timestamp())::date;
  schedule_row record;
begin
  for schedule_row in
    select entry.id
    from public.caregiver_schedule_entries as entry
    join public.caregiver_assignments as assignment
      on assignment.id = entry.caregiver_assignment_id
    join public.patients as patient
      on patient.id = assignment.patient_id
    where entry.scheduled_date > local_today
      and (
        not assignment.active
        or (assignment.end_date is not null and entry.scheduled_date > assignment.end_date)
        or patient.status = 'inativo'
      )
  loop
    perform private.sync_caregiver_schedule_payroll(schedule_row.id);
  end loop;
end;
$$;

commit;
