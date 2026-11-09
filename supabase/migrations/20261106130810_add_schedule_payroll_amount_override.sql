begin;

alter table public.caregiver_schedule_entries
  add column payroll_amount_override_cents integer,
  add constraint caregiver_schedule_entries_payroll_amount_override_range
    check (
      payroll_amount_override_cents is null
      or payroll_amount_override_cents between 1 and 100000000
    );

create or replace function private.sync_caregiver_schedule_payroll(target_schedule_entry_id uuid)
returns void
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  shift_date date;
  schedule_created_by uuid;
  target_caregiver_user_id uuid;
  caregiver_name text;
  patient_name text;
  shift_rate_cents integer;
  has_manual_or_paid_expense boolean;
begin
  select entry.scheduled_date,
         entry.created_by,
         assignment.caregiver_user_id,
         coalesce(caregiver.name, 'Profissional'),
         coalesce(patient.name, 'Paciente'),
         coalesce(entry.payroll_amount_override_cents, rate.amount_cents)
    into shift_date,
         schedule_created_by,
         target_caregiver_user_id,
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

create or replace function private.prevent_paid_caregiver_schedule_change()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if (new.scheduled_date is distinct from old.scheduled_date
      or new.caregiver_assignment_id is distinct from old.caregiver_assignment_id
      or new.payroll_amount_override_cents is distinct from old.payroll_amount_override_cents)
     and exists (
       select 1
       from public.finance_expenses as expense
       where expense.caregiver_schedule_entry_id = old.id
         and expense.paid_on is not null
     ) then
    raise exception using
      errcode = '23514',
      message = 'PAYROLL_PAID_SCHEDULE_CONFLICT';
  end if;
  return new;
end;
$$;

drop trigger if exists caregiver_schedule_entries_sync_payroll_update
  on public.caregiver_schedule_entries;
create trigger caregiver_schedule_entries_sync_payroll_update
after update of caregiver_assignment_id, scheduled_date, profession, payroll_amount_override_cents
on public.caregiver_schedule_entries
for each row execute function private.sync_caregiver_schedule_payroll_trigger();

drop trigger if exists caregiver_schedule_entries_prevent_paid_payroll_change
  on public.caregiver_schedule_entries;
create trigger caregiver_schedule_entries_prevent_paid_payroll_change
before update of caregiver_assignment_id, scheduled_date, payroll_amount_override_cents
on public.caregiver_schedule_entries
for each row execute function private.prevent_paid_caregiver_schedule_change();

commit;
