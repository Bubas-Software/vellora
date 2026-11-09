begin;

-- Add the operational coordination role without granting any financial role.
alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role = any (array['admin', 'coordenador_operacional', 'familia', 'cuidador']::text[]));

create or replace function private.is_coordinator()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select coalesce((select private.current_active()), false)
    and (select private.current_role()) = 'coordenador_operacional'
$$;

revoke all on function private.is_coordinator() from public, anon;
grant execute on function private.is_coordinator() to authenticated, service_role;

-- Profiles are visible to coordination for operational linking and directory
-- screens. Coordinators can update family/caregiver operational data, while
-- the trigger below keeps role and account activation Admin-only.
alter policy profiles_select_self_or_admin
on public.profiles
using (
  id = (select auth.uid())
  or (select private.is_admin())
  or (select private.is_coordinator())
);

create policy profiles_update_coordinator_operational
on public.profiles for update to authenticated
using (
  (select private.is_coordinator())
  and role in ('familia', 'cuidador')
)
with check (
  (select private.is_coordinator())
  and role in ('familia', 'cuidador')
);

create or replace function private.prevent_non_admin_profile_privilege_change()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if current_user not in ('postgres', 'service_role')
    and not coalesce((select private.is_admin()), false)
    and (
      new.role is distinct from old.role
      or new.active is distinct from old.active
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Only Admin can change a profile role or active state';
  end if;
  return new;
end;
$$;

revoke all on function private.prevent_non_admin_profile_privilege_change() from public, anon;
grant execute on function private.prevent_non_admin_profile_privilege_change() to authenticated, service_role;

drop trigger if exists profiles_prevent_non_admin_privilege_change on public.profiles;
create trigger profiles_prevent_non_admin_privilege_change
before update of role, active on public.profiles
for each row execute function private.prevent_non_admin_profile_privilege_change();

-- Operational records and directories.
create policy leads_coordinator_all
on public.leads for all to authenticated
using ((select private.is_coordinator()))
with check ((select private.is_coordinator()));

create policy professional_applications_coordinator_all
on public.professional_applications for all to authenticated
using ((select private.is_coordinator()))
with check ((select private.is_coordinator()));

create policy caregiver_profiles_coordinator_all
on public.caregiver_profiles for all to authenticated
using ((select private.is_coordinator()))
with check ((select private.is_coordinator()));

alter policy caregiver_profiles_select_admin_or_self
on public.caregiver_profiles
using (
  (select private.is_admin())
  or (select private.is_coordinator())
  or (
    user_id = (select auth.uid())
    and (select private.current_active())
    and (select private.current_role()) = 'cuidador'
  )
);

alter policy patients_select_authorized
on public.patients
using (
  (select private.is_admin())
  or (select private.is_coordinator())
  or private.is_patient_family(id)
  or private.is_active_caregiver(id)
);

create policy patients_insert_coordinator
on public.patients for insert to authenticated
with check ((select private.is_coordinator()));

create policy patients_update_coordinator
on public.patients for update to authenticated
using ((select private.is_coordinator()))
with check ((select private.is_coordinator()));

alter policy assignments_select_authorized
on public.caregiver_assignments
using (
  (select private.is_admin())
  or (select private.is_coordinator())
  or (
    caregiver_user_id = (select auth.uid())
    and (select private.current_active())
    and (select private.current_role()) = 'cuidador'
  )
  or private.is_patient_family(patient_id)
);

create policy assignments_coordinator_insert
on public.caregiver_assignments for insert to authenticated
with check ((select private.is_coordinator()));

create policy assignments_coordinator_update
on public.caregiver_assignments for update to authenticated
using ((select private.is_coordinator()))
with check ((select private.is_coordinator()));

create policy assignments_coordinator_delete
on public.caregiver_assignments for delete to authenticated
using ((select private.is_coordinator()));

-- Clinical records and history are explicitly included in this role. Deleting
-- a clinical record remains Admin-only so the audit trail stays intact.
alter policy daily_records_select_authorized
on public.daily_records
using (
  (select private.is_admin())
  or (select private.is_coordinator())
  or (select private.is_patient_family(patient_id))
  or (select private.is_active_caregiver(patient_id))
);

alter policy daily_records_insert_authorized
on public.daily_records
with check (
  (select private.is_admin())
  or (select private.is_coordinator())
  or (
    caregiver_user_id = (select auth.uid())
    and private.is_active_caregiver(patient_id)
  )
);

alter policy daily_records_update_authorized
on public.daily_records
using (
  (select private.is_admin())
  or (select private.is_coordinator())
  or (
    caregiver_user_id = (select auth.uid())
    and private.is_active_caregiver(patient_id)
  )
)
with check (
  (select private.is_admin())
  or (select private.is_coordinator())
  or (
    caregiver_user_id = (select auth.uid())
    and private.is_active_caregiver(patient_id)
  )
);

alter policy daily_record_audit_select_authorized
on public.daily_record_audit_events
using (
  (select private.is_admin())
  or (select private.is_coordinator())
  or private.is_patient_family(patient_id)
  or private.is_active_caregiver(patient_id)
);

create policy contract_documents_coordinator_select
on public.contract_documents for select to authenticated
using ((select private.is_coordinator()));

create policy contract_documents_coordinator_insert
on public.contract_documents for insert to authenticated
with check ((select private.is_coordinator()));

create policy contract_documents_coordinator_update
on public.contract_documents for update to authenticated
using ((select private.is_coordinator()))
with check ((select private.is_coordinator()));

create policy contract_documents_coordinator_delete
on public.contract_documents for delete to authenticated
using ((select private.is_coordinator()));

-- Coordinators manage schedules, but cannot read or write either payroll
-- column directly through PostgREST. Admins use the two guarded RPCs below.
revoke select, insert, update
on table public.caregiver_schedule_entries
from authenticated;

grant select (
  id,
  caregiver_assignment_id,
  scheduled_date,
  start_time,
  end_time,
  ends_next_day,
  profession,
  created_by,
  updated_by,
  created_at,
  updated_at
)
on table public.caregiver_schedule_entries to authenticated;

grant insert (
  id,
  caregiver_assignment_id,
  scheduled_date,
  start_time,
  end_time,
  ends_next_day,
  profession,
  created_by,
  updated_by
)
on table public.caregiver_schedule_entries to authenticated;

grant update (
  caregiver_assignment_id,
  scheduled_date,
  start_time,
  end_time,
  ends_next_day,
  profession,
  updated_by,
  updated_at
)
on table public.caregiver_schedule_entries to authenticated;

create policy caregiver_schedule_entries_select_coordinator
on public.caregiver_schedule_entries for select to authenticated
using ((select private.is_coordinator()));

create policy caregiver_schedule_entries_insert_coordinator
on public.caregiver_schedule_entries for insert to authenticated
with check ((select private.is_coordinator()));

create policy caregiver_schedule_entries_update_coordinator
on public.caregiver_schedule_entries for update to authenticated
using ((select private.is_coordinator()))
with check ((select private.is_coordinator()));

create policy caregiver_schedule_entries_delete_coordinator
on public.caregiver_schedule_entries for delete to authenticated
using ((select private.is_coordinator()));

create or replace function public.get_schedule_payroll_details(p_schedule_entry_ids uuid[])
returns table (
  schedule_entry_id uuid,
  payroll_amount_override_cents integer,
  payroll_rate_status text
)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
begin
  if not coalesce((select private.is_admin()), false) then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;
  if p_schedule_entry_ids is null
    or pg_catalog.cardinality(p_schedule_entry_ids) > 500
    or exists (select 1 from pg_catalog.unnest(p_schedule_entry_ids) as item(id) where item.id is null)
  then
    raise exception using errcode = '22023', message = 'SCHEDULE_IDS_INVALID';
  end if;

  return query
  select entry.id, entry.payroll_amount_override_cents, entry.payroll_rate_status
  from public.caregiver_schedule_entries as entry
  where entry.id = any (p_schedule_entry_ids);
end;
$$;

revoke all on function public.get_schedule_payroll_details(uuid[]) from public, anon;
grant execute on function public.get_schedule_payroll_details(uuid[]) to authenticated, service_role;

create or replace function public.set_schedule_payroll_override(
  p_schedule_entry_id uuid,
  p_amount_cents integer
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if not coalesce((select private.is_admin()), false) then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;
  if p_schedule_entry_id is null
    or (p_amount_cents is not null and p_amount_cents not between 1 and 100000000)
  then
    raise exception using errcode = '22023', message = 'PAYROLL_OVERRIDE_INVALID';
  end if;

  update public.caregiver_schedule_entries
  set payroll_amount_override_cents = p_amount_cents,
      updated_by = (select auth.uid()),
      updated_at = pg_catalog.now()
  where id = p_schedule_entry_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'SCHEDULE_ENTRY_NOT_FOUND';
  end if;
end;
$$;

revoke all on function public.set_schedule_payroll_override(uuid, integer) from public, anon;
grant execute on function public.set_schedule_payroll_override(uuid, integer) to authenticated, service_role;

-- The family screen receives service labels only. The tariff amount remains
-- available exclusively through the Admin-only table policy and API.
create or replace function public.list_family_contracted_services(p_family_user_id uuid)
returns table (patient_id uuid, profession text)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
begin
  if not (
    coalesce((select private.is_admin()), false)
    or coalesce((select private.is_coordinator()), false)
  ) then
    raise exception using errcode = '42501', message = 'ADMIN_ACCESS_REQUIRED';
  end if;

  return query
  select distinct rate.patient_id, rate.profession
  from public.family_patient_service_rates as rate
  where rate.family_user_id = p_family_user_id
    and rate.valid_from <= current_date
    and (rate.valid_to is null or rate.valid_to >= current_date)
  order by rate.patient_id, rate.profession;
end;
$$;

revoke all on function public.list_family_contracted_services(uuid) from public, anon;
grant execute on function public.list_family_contracted_services(uuid) to authenticated, service_role;

-- Storage access for clinical photos and contract documents follows the same
-- operational role and strict object-key shapes already used by the Admin.
create policy record_photos_select_coordinator
on storage.objects for select to authenticated
using (
  bucket_id = 'record-photos'
  and name ~ '^patients/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/records/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[.](jpg|jpeg|png|webp)$'
  and (select private.is_coordinator())
);

create policy record_photos_insert_coordinator
on storage.objects for insert to authenticated
with check (
  bucket_id = 'record-photos'
  and name ~ '^patients/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/records/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[.](jpg|jpeg|png|webp)$'
  and (select private.is_coordinator())
);

create policy record_photos_update_coordinator
on storage.objects for update to authenticated
using (
  bucket_id = 'record-photos'
  and name ~ '^patients/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/records/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[.](jpg|jpeg|png|webp)$'
  and (select private.is_coordinator())
)
with check (
  bucket_id = 'record-photos'
  and name ~ '^patients/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/records/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[.](jpg|jpeg|png|webp)$'
  and (select private.is_coordinator())
);

create policy record_photos_delete_coordinator
on storage.objects for delete to authenticated
using (
  bucket_id = 'record-photos'
  and name ~ '^patients/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/records/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[.](jpg|jpeg|png|webp)$'
  and (select private.is_coordinator())
);

create policy contracts_select_coordinator
on storage.objects for select to authenticated
using (
  bucket_id = 'contracts'
  and name ~ '^contracts/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[.]pdf$'
  and (select private.is_coordinator())
  and exists (
    select 1 from public.contract_documents as document
    where document.storage_key = name
  )
);

create policy contracts_insert_coordinator
on storage.objects for insert to authenticated
with check (
  bucket_id = 'contracts'
  and name ~ '^contracts/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[.]pdf$'
  and (select private.is_coordinator())
);

create policy contracts_update_coordinator
on storage.objects for update to authenticated
using (
  bucket_id = 'contracts'
  and name ~ '^contracts/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[.]pdf$'
  and (select private.is_coordinator())
)
with check (
  bucket_id = 'contracts'
  and name ~ '^contracts/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[.]pdf$'
  and (select private.is_coordinator())
);

create policy contracts_delete_coordinator
on storage.objects for delete to authenticated
using (
  bucket_id = 'contracts'
  and name ~ '^contracts/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[.]pdf$'
  and (select private.is_coordinator())
);

-- Payroll triggers must continue to synchronize and protect financial rows
-- while invoked by operational users. The helpers return no financial data,
-- and direct calls remain unavailable to authenticated users.
alter function private.sync_caregiver_schedule_payroll(uuid) security definer;
alter function private.sync_caregiver_schedule_payroll_trigger() security definer;
alter function private.prevent_paid_caregiver_schedule_change() security definer;
alter function private.prevent_paid_caregiver_assignment_change() security definer;
alter function private.sync_caregiver_assignment_payroll() security definer;
alter function private.sync_patient_family_payroll() security definer;
alter function private.sync_family_patient_service_rate_payroll() security definer;

revoke all on function private.sync_caregiver_schedule_payroll(uuid) from public, anon, authenticated;
revoke all on function private.sync_caregiver_schedule_payroll_trigger() from public, anon, authenticated;
revoke all on function private.prevent_paid_caregiver_schedule_change() from public, anon, authenticated;
revoke all on function private.prevent_paid_caregiver_assignment_change() from public, anon, authenticated;
revoke all on function private.sync_caregiver_assignment_payroll() from public, anon, authenticated;
revoke all on function private.sync_patient_family_payroll() from public, anon, authenticated;
revoke all on function private.sync_family_patient_service_rate_payroll() from public, anon, authenticated;

grant execute on function private.sync_caregiver_schedule_payroll(uuid) to service_role;
grant execute on function private.sync_caregiver_schedule_payroll_trigger() to service_role;
grant execute on function private.prevent_paid_caregiver_schedule_change() to service_role;
grant execute on function private.prevent_paid_caregiver_assignment_change() to service_role;
grant execute on function private.sync_caregiver_assignment_payroll() to service_role;
grant execute on function private.sync_patient_family_payroll() to service_role;
grant execute on function private.sync_family_patient_service_rate_payroll() to service_role;

notify pgrst, 'reload schema';

commit;
