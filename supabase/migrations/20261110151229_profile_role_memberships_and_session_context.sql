begin;

-- Additive role memberships keep the current profile ID, its legacy/default
-- role, and every business relationship intact.
create table public.profile_role_memberships (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (
    role = any (array['admin', 'coordenador_operacional', 'familia', 'cuidador']::text[])
  ),
  active boolean not null default true,
  is_default boolean not null default false,
  granted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (profile_id, role)
);

create index profile_role_memberships_active_idx
  on public.profile_role_memberships (profile_id, active);

alter table public.profile_role_memberships enable row level security;
revoke all on table public.profile_role_memberships from public, anon, authenticated;
grant select on table public.profile_role_memberships to authenticated;

create policy profile_role_memberships_select_self_or_admin
on public.profile_role_memberships for select to authenticated
using (
  profile_id = (select auth.uid())
  or (select private.is_admin())
);

-- Backfill one default membership per existing profile. This only inserts
-- role metadata; profiles and records linked to their IDs are not rewritten.
insert into public.profile_role_memberships (profile_id, role, active, is_default)
select id, role, true, true
from public.profiles
on conflict (profile_id, role) do nothing;

create or replace function private.seed_profile_default_role_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  insert into public.profile_role_memberships (profile_id, role, active, is_default)
  values (new.id, new.role, true, true)
  on conflict (profile_id, role) do nothing;
  return new;
end;
$$;

revoke all on function private.seed_profile_default_role_membership() from public, anon, authenticated;

create trigger profiles_seed_default_role_membership
after insert on public.profiles
for each row execute function private.seed_profile_default_role_membership();

-- The selected access context is scoped to a Supabase Auth session. Choosing
-- a role on one device/session does not change another session or the stored
-- default role. This private table is only read/written by the functions below.
create table private.profile_role_sessions (
  session_id uuid primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (
    role = any (array['admin', 'coordenador_operacional', 'familia', 'cuidador']::text[])
  ),
  updated_at timestamptz not null default now(),
  foreign key (profile_id, role)
    references public.profile_role_memberships(profile_id, role) on delete cascade
);

alter table private.profile_role_sessions enable row level security;
revoke all on table private.profile_role_sessions from public, anon, authenticated;

-- Existing RLS and SECURITY DEFINER policies continue to call this helper.
-- With several active roles, no application data is accessible until this
-- Auth session explicitly chooses one. Single-role users keep their current
-- login behavior.
create or replace function private.current_role()
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select case
    when exists (
      select 1
      from private.profile_role_sessions as selected
      join public.profile_role_memberships as membership
        on membership.profile_id = selected.profile_id
       and membership.role = selected.role
       and membership.active = true
      join public.profiles as profile
        on profile.id = selected.profile_id
       and profile.active = true
      where selected.session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
        and selected.profile_id = auth.uid()
    ) then (
      select selected.role
      from private.profile_role_sessions as selected
      join public.profile_role_memberships as membership
        on membership.profile_id = selected.profile_id
       and membership.role = selected.role
       and membership.active = true
      join public.profiles as profile
        on profile.id = selected.profile_id
       and profile.active = true
      where selected.session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
        and selected.profile_id = auth.uid()
      limit 1
    )
    when (
      select count(*)
      from public.profile_role_memberships as membership
      join public.profiles as profile on profile.id = membership.profile_id
      where membership.profile_id = auth.uid()
        and membership.active = true
        and profile.active = true
    ) = 1 then (
      select membership.role
      from public.profile_role_memberships as membership
      join public.profiles as profile on profile.id = membership.profile_id
      where membership.profile_id = auth.uid()
        and membership.active = true
        and profile.active = true
      limit 1
    )
    else null
  end
$$;

revoke execute on function private.current_role() from public, anon;
grant execute on function private.current_role() to authenticated, service_role;

create or replace function public.get_my_profile_role_context()
returns table (
  available_roles text[],
  active_role text,
  needs_selection boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_profile_id uuid := auth.uid();
  v_session_id uuid;
  v_roles text[];
  v_active_role text;
begin
  if v_profile_id is null then
    raise exception using errcode = '28000', message = 'AUTHENTICATION_REQUIRED';
  end if;

  v_session_id := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  if v_session_id is null then
    raise exception using errcode = '28000', message = 'AUTH_SESSION_REQUIRED';
  end if;

  select pg_catalog.array_agg(membership.role order by membership.is_default desc, membership.role)
    into v_roles
  from public.profile_role_memberships as membership
  join public.profiles as profile on profile.id = membership.profile_id
  where membership.profile_id = v_profile_id
    and membership.active = true
    and profile.active = true;

  if v_roles is null or pg_catalog.cardinality(v_roles) = 0 then
    raise exception using errcode = '42501', message = 'NO_ACTIVE_PROFILE_ROLE';
  end if;

  select selected.role into v_active_role
  from private.profile_role_sessions as selected
  where selected.session_id = v_session_id
    and selected.profile_id = v_profile_id
    and selected.role = any (v_roles);

  if v_active_role is null and pg_catalog.cardinality(v_roles) = 1 then
    v_active_role := v_roles[1];
  end if;

  return query select v_roles, v_active_role,
    (pg_catalog.cardinality(v_roles) > 1 and v_active_role is null);
end;
$$;

create or replace function public.select_active_profile_role(p_role text)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_profile_id uuid := auth.uid();
  v_session_id uuid;
begin
  if v_profile_id is null then
    raise exception using errcode = '28000', message = 'AUTHENTICATION_REQUIRED';
  end if;

  v_session_id := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  if v_session_id is null then
    raise exception using errcode = '28000', message = 'AUTH_SESSION_REQUIRED';
  end if;

  if not exists (
    select 1
    from public.profiles as profile
    join public.profile_role_memberships as membership on membership.profile_id = profile.id
    where profile.id = v_profile_id
      and profile.active = true
      and membership.role = p_role
      and membership.active = true
  ) then
    raise exception using errcode = '42501', message = 'PROFILE_ROLE_NOT_AVAILABLE';
  end if;

  insert into private.profile_role_sessions (session_id, profile_id, role, updated_at)
  values (v_session_id, v_profile_id, p_role, now())
  on conflict (session_id) do update
    set profile_id = excluded.profile_id,
        role = excluded.role,
        updated_at = excluded.updated_at;

  return p_role;
end;
$$;

revoke all on function public.get_my_profile_role_context() from public, anon;
revoke all on function public.select_active_profile_role(text) from public, anon;
grant execute on function public.get_my_profile_role_context() to authenticated;
grant execute on function public.select_active_profile_role(text) to authenticated;

notify pgrst, 'reload schema';

commit;
