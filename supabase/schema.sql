-- =====================================================================
--  Stock BdN – schéma Supabase (Postgres)
--  À coller dans Supabase > SQL Editor > New query > Run
--  Rejouable : peut être exécuté plusieurs fois sans casser l'existant.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Migration des rôles (v2 -> v3) ---------------------------
-- Les rôles passent d'un type « enum » à du texte, avec 4 niveaux :
--   technicien < regisseur < regisseur_general < admin
-- Correspondance pour une base existante : lecteur -> technicien ; ancien technicien -> regisseur ; admin inchangé.
do $$ begin
  if exists (select 1 from pg_type where typname = 'app_role') then
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'profiles' and column_name = 'role' and udt_name = 'app_role') then
      alter table profiles alter column role drop default;
      alter table profiles alter column role type text
        using (case role::text when 'lecteur' then 'technicien' when 'technicien' then 'regisseur' else role::text end);
    end if;
    drop function if exists has_role(app_role) cascade;   -- les règles RLS qui en dépendent sont recréées plus bas
    drop function if exists role_rank(app_role) cascade;
    drop type app_role;
  end if;
end $$;

do $$ begin
  create type item_status as enum ('dispo', 'sav', 'en_pret');
exception when duplicate_object then null; end $$;

-- ---------- Utilisateurs & rôles ------------------------------------
create table if not exists profiles (
  id         uuid primary key references auth.users on delete cascade,
  email      text not null,
  role       text not null default 'technicien',
  active     boolean not null default true,      -- false = accès révoqué (le compte existe toujours)
  created_at timestamptz not null default now()
);
alter table profiles add column if not exists active boolean not null default true;
alter table profiles add column if not exists first_name text not null default '';
alter table profiles add column if not exists last_name  text not null default '';
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in ('technicien', 'regisseur', 'regisseur_general', 'admin'));

-- Le tout premier compte créé devient admin, les suivants sont 'technicien' (niveau le plus bas).
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, role)
  values (new.id, new.email,
          case when exists (select 1 from profiles) then 'technicien' else 'admin' end)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

create or replace function role_rank(r text) returns int
language sql immutable as $$
  select case r when 'admin' then 4 when 'regisseur_general' then 3 when 'regisseur' then 2 when 'technicien' then 1 else 0 end
$$;

-- vrai si l'utilisateur connecté a au moins le rôle demandé
create or replace function has_role(min_role text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select active and role_rank(role) >= role_rank(min_role) from profiles where id = auth.uid()), false)
$$;

-- Il doit toujours rester au moins un administrateur actif.
create or replace function protect_last_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and old.active
     and (tg_op = 'DELETE' or new.role <> 'admin' or not new.active)
     and not exists (select 1 from profiles where role = 'admin' and active and id <> old.id) then
    raise exception 'Impossible : il doit rester au moins un administrateur actif' using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists profiles_protect_last_admin on profiles;
create trigger profiles_protect_last_admin before update or delete on profiles
  for each row execute function protect_last_admin();

-- ---------- Référentiels --------------------------------------------
create table if not exists families (
  id text primary key default encode(gen_random_bytes(4), 'hex'),
  name text not null unique
);
create table if not exists item_types (
  id text primary key default encode(gen_random_bytes(4), 'hex'),
  name text not null unique
);
create table if not exists sockets (
  id text primary key default encode(gen_random_bytes(4), 'hex'),
  name text not null unique
);
create table if not exists filter_sizes (
  id text primary key default encode(gen_random_bytes(4), 'hex'),
  label text not null unique,
  sheets_lee int,
  sheets_rosco int
);
create table if not exists lamps (
  id text primary key default encode(gen_random_bytes(4), 'hex'),
  name text not null unique,
  power_w int,
  temp_k int,
  socket_id text references sockets(id) on delete set null
);
create table if not exists models (
  id text primary key default encode(gen_random_bytes(4), 'hex'),
  name text not null unique,
  family_id text references families(id) on delete set null,
  type_id text references item_types(id) on delete set null,
  filter_size_id text references filter_sizes(id) on delete set null,
  socket_id text references sockets(id) on delete set null,
  notice_url text
);

-- ---------- Parc : un projecteur = une ligne --------------------------
create table if not exists items (
  id           integer generated by default as identity primary key,  -- = numéro du sticker / QR
  model_id     text not null references models(id),
  lamp_id      text references lamps(id) on delete set null,
  status       item_status not null default 'dispo',
  status_at    timestamptz not null default now(),   -- horodatage (côté client) du dernier changement d'état
  last_service date,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists items_model_idx on items(model_id);
create index if not exists items_status_idx on items(status);

create table if not exists faults (
  id                uuid primary key default gen_random_uuid(),  -- généré côté appareil (hors ligne)
  item_id           integer not null references items(id) on delete cascade,
  description       text,
  reported_by       uuid references auth.users on delete set null,
  reported_by_label text,
  reported_at       timestamptz not null default now(),
  resolved_at       timestamptz,
  resolved_by       uuid references auth.users on delete set null,
  resolution        text
);
alter table faults add column if not exists resolved_by_label text;
create index if not exists faults_item_idx on faults(item_id);

-- Journal des pannes : chaque info ajoutée et chaque modification de description est conservée (qui, quand, ancienne valeur).
-- La déclaration et la résolution sont déjà tracées dans faults (reported_by_label / reported_at, resolved_by_label / resolved_at).
create table if not exists fault_log (
  id        uuid primary key default gen_random_uuid(),   -- généré côté appareil : rejeu sans doublon
  fault_id  uuid not null references faults(id) on delete cascade,
  kind      text not null check (kind in ('note', 'edit')),
  text      text not null,
  old_text  text,
  by        uuid references auth.users on delete set null,
  by_label  text,
  at        timestamptz not null default now()
);
create index if not exists fault_log_fault_idx on fault_log(fault_id);

-- Journal : chaque action est rejouable une seule fois (id = clé d'idempotence)
create table if not exists item_events (
  id               uuid primary key,
  item_id          integer not null references items(id) on delete cascade,
  kind             text not null check (kind in ('status', 'fault', 'fault_resolved')),
  status           item_status,
  note             text,
  created_by       uuid references auth.users on delete set null,
  created_by_label text,
  at               timestamptz not null default now()
);
create index if not exists item_events_item_idx on item_events(item_id, at desc);

-- Agenda d'un projecteur : ses immobilisations (prêts et périodes de SAV). Disponible = aucune ligne ouverte.
create table if not exists immos (
  id               uuid primary key default gen_random_uuid(),
  item_id          integer not null references items(id) on delete cascade,
  kind             text not null check (kind in ('pret', 'sav')),
  who              text,                 -- emprunteur (prêts)
  note             text,                 -- motif, remarque
  start_date       date not null,
  end_date         date,                 -- fin prévue (retour prévu / fin de SAV prévue) ; vide = non connue
  closed_date      date,                 -- fin réelle (retour effectif / réparation terminée) ; vide = en cours
  created_by       uuid references auth.users on delete set null,
  created_by_label text,
  created_at       timestamptz not null default now(),
  constraint immos_dates check ((end_date is null or end_date >= start_date) and (closed_date is null or closed_date >= start_date))
);
create index if not exists immos_item_idx on immos(item_id, start_date);

-- ---------- Fonctions appelées par l'appli (idempotentes) -------------
drop function if exists apply_status(uuid, int, item_status, text, timestamptz);
create or replace function apply_status(p_event uuid, p_item int, p_status item_status, p_note text, p_at timestamptz,
                                        p_who text default null, p_from date default null, p_until date default null)
returns void language plpgsql security definer set search_path = public as $$
declare prev item_status; cur_at timestamptz; n int; lbl text; d date; d0 date;
begin
  if not has_role('regisseur_general') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  d := (p_at at time zone 'Europe/Paris')::date;
  d0 := coalesce(p_from, d);
  if d0 > d then raise exception 'La date de début ne peut pas être dans le futur (utilise « Planifier » dans l''agenda)' using errcode = '22023'; end if;
  if p_until is not null and p_until < d0 then raise exception 'La date de fin précède la date de début' using errcode = '22023'; end if;
  insert into item_events (id, item_id, kind, status, note, created_by, created_by_label, at)
  values (p_event, p_item, 'status', p_status, p_note, auth.uid(), lbl, p_at)
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  if n = 0 then return; end if;                       -- déjà appliqué
  select status, status_at into prev, cur_at from items where id = p_item;
  if not found then raise exception 'Projecteur % introuvable', p_item using errcode = 'P0002'; end if;
  perform log_event('STATUT', format('#%s : %s → %s%s%s%s', p_item, status_label(prev), status_label(p_status),
    case when nullif(trim(p_who), '') is not null then ' — ' || trim(p_who) else '' end,
    case when nullif(trim(p_note), '') is not null then ' — ' || trim(p_note) else '' end,
    case when p_at < cur_at then ' (ignoré : plus ancien que le dernier changement)' else '' end));
  if p_at >= cur_at then                              -- le plus récent gagne
    update items set status = p_status, status_at = p_at, updated_at = now(),
           last_service = case when prev = 'sav' and p_status = 'dispo' then p_at::date else last_service end
     where id = p_item;
    -- agenda : on clôt ce qui était en cours, puis on ouvre la nouvelle immobilisation
    update immos set closed_date = greatest(d, start_date) where item_id = p_item and closed_date is null and start_date <= d;
    if p_status = 'en_pret' then
      insert into immos (item_id, kind, who, note, start_date, end_date, created_by, created_by_label)
      values (p_item, 'pret', nullif(trim(p_who), ''), nullif(trim(p_note), ''), d0, p_until, auth.uid(), lbl);
    elsif p_status = 'sav' then
      insert into immos (item_id, kind, note, start_date, end_date, created_by, created_by_label)
      values (p_item, 'sav', nullif(trim(p_note), ''), d0, p_until, auth.uid(), lbl);
    end if;
  end if;
end $$;

-- Agenda : ajout / correction / suppression manuelle d'une période (planifier un prêt futur, corriger une date…).
-- Ne change pas l'état courant du projecteur.
create or replace function add_immo(p_id uuid, p_item int, p_kind text, p_who text, p_note text, p_start date, p_end date, p_closed date)
returns void language plpgsql security definer set search_path = public as $$
declare lbl text; n int;
begin
  if not has_role('regisseur_general') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  insert into immos (id, item_id, kind, who, note, start_date, end_date, closed_date, created_by, created_by_label)
  values (p_id, p_item, p_kind, nullif(trim(p_who), ''), nullif(trim(p_note), ''), p_start, p_end, p_closed, auth.uid(), lbl)
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  if n > 0 then perform log_event('AGENDA', format('#%s : %s ajouté du %s%s%s', p_item, case p_kind when 'pret' then 'prêt' else 'SAV' end,
      to_char(p_start, 'DD/MM/YYYY'), coalesce(' au ' || to_char(coalesce(p_closed, p_end), 'DD/MM/YYYY'), ''), coalesce(' — ' || nullif(trim(p_who), ''), ''))); end if;
end $$;

create or replace function edit_immo(p_id uuid, p_who text, p_note text, p_start date, p_end date, p_closed date)
returns void language plpgsql security definer set search_path = public as $$
declare it int;
begin
  if not has_role('regisseur_general') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  update immos set who = nullif(trim(p_who), ''), note = nullif(trim(p_note), ''), start_date = p_start, end_date = p_end, closed_date = p_closed
   where id = p_id returning item_id into it;
  if not found then raise exception 'Période introuvable' using errcode = '22023'; end if;
  perform log_event('AGENDA', format('#%s : période modifiée (%s → %s)', it, to_char(p_start, 'DD/MM/YYYY'), coalesce(to_char(coalesce(p_closed, p_end), 'DD/MM/YYYY'), 'sans fin')));
end $$;

create or replace function delete_immo(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare it int;
begin
  if not has_role('regisseur_general') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  delete from immos where id = p_id returning item_id into it;
  if found then perform log_event('AGENDA', format('#%s : période supprimée', it)); end if;
end $$;

create or replace function report_fault(p_id uuid, p_item int, p_description text, p_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare lbl text; n int;
begin
  if not has_role('technicien') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  insert into faults (id, item_id, description, reported_by, reported_by_label, reported_at)
  values (p_id, p_item, nullif(trim(p_description), ''), auth.uid(), lbl, p_at)
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  if n > 0 then
    insert into item_events (id, item_id, kind, note, created_by, created_by_label, at)
    values (gen_random_uuid(), p_item, 'fault', p_description, auth.uid(), lbl, p_at);
    perform log_event('PANNE', format('#%s : panne déclarée%s', p_item, coalesce(' — ' || nullif(trim(p_description), ''), '')));
  end if;
end $$;

create or replace function resolve_fault(p_event uuid, p_fault uuid, p_resolution text, p_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare lbl text; it int; n int;
begin
  if not has_role('regisseur') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  update faults set resolved_at = p_at, resolved_by = auth.uid(), resolved_by_label = lbl, resolution = nullif(trim(p_resolution), '')
   where id = p_fault and resolved_at is null
   returning item_id into it;
  get diagnostics n = row_count;
  if n > 0 then
    insert into item_events (id, item_id, kind, note, created_by, created_by_label, at)
    values (p_event, it, 'fault_resolved', p_resolution, auth.uid(), lbl, p_at)
    on conflict (id) do nothing;
    perform log_event('RESOLU', format('#%s : panne résolue%s', it, coalesce(' — ' || nullif(trim(p_resolution), ''), '')));
  end if;
end $$;

create or replace function add_fault_note(p_id uuid, p_fault uuid, p_note text, p_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare lbl text; n int; it int;
begin
  if not has_role('technicien') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  if nullif(trim(p_note), '') is null then raise exception 'Texte vide' using errcode = '22023'; end if;
  if not exists (select 1 from faults where id = p_fault) then raise exception 'Panne introuvable' using errcode = '22023'; end if;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  insert into fault_log (id, fault_id, kind, text, by, by_label, at)
  values (p_id, p_fault, 'note', trim(p_note), auth.uid(), lbl, p_at)
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  if n > 0 then
    select item_id into it from faults where id = p_fault;
    perform log_event('INFO', format('#%s : info ajoutée à la panne — %s', it, trim(p_note)));
  end if;
end $$;

-- Modifier la description : le régisseur et au-dessus pour toutes les pannes, un technicien pour celles qu'il a déclarées.
create or replace function edit_fault(p_id uuid, p_fault uuid, p_description text, p_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare lbl text; f faults; n int;
begin
  if not has_role('technicien') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  select * into f from faults where id = p_fault;
  if not found then raise exception 'Panne introuvable' using errcode = '22023'; end if;
  if not (has_role('regisseur') or f.reported_by = auth.uid()) then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  if nullif(trim(p_description), '') is null then raise exception 'Texte vide' using errcode = '22023'; end if;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  insert into fault_log (id, fault_id, kind, text, old_text, by, by_label, at)
  values (p_id, p_fault, 'edit', trim(p_description), f.description, auth.uid(), lbl, p_at)
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  if n > 0 then
    update faults set description = trim(p_description) where id = p_fault;
    perform log_event('MODIF', format('#%s : description de panne modifiée — « %s » → « %s »', f.item_id, coalesce(f.description, ''), trim(p_description)));
  end if;
end $$;


-- ---------- Journal d'activité (réservé aux administrateurs) -----------------
create table if not exists app_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  actor_label text,
  kind        text not null,
  message     text not null
);
create index if not exists app_log_at_idx on app_log(at);

create or replace function status_label(s item_status) returns text language sql immutable as $$
  select case s when 'dispo' then 'dispo' when 'sav' then 'SAV' when 'en_pret' then 'en prêt' else s::text end $$;

-- Écrit une ligne (appelée par les fonctions et déclencheurs ci-dessous, jamais directement par un utilisateur).
create or replace function log_event(p_kind text, p_msg text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into app_log (actor, actor_label, kind, message)
  values (auth.uid(), (select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) from profiles where id = auth.uid()), p_kind, p_msg);
end $$;
revoke all on function log_event(text, text) from public;

-- Connexion : appelée par l'appli juste après l'identification.
create or replace function log_login() returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_role('technicien') then return; end if;
  perform log_event('CONNEXION', 'connexion à l''application');
end $$;
revoke all on function log_login() from public;
grant execute on function log_login() to authenticated;

-- Suppression de lignes du journal (la suppression laisse elle-même une trace).
create or replace function delete_log_lines(p_ids bigint[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not has_role('admin') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  delete from app_log where id = any(p_ids);
  get diagnostics n = row_count;
  if n > 0 then perform log_event('JOURNAL', format('%s ligne(s) du journal supprimée(s)', n)); end if;
  return n;
end $$;
revoke all on function delete_log_lines(bigint[]) from public;
grant execute on function delete_log_lines(bigint[]) to authenticated;

-- Projecteurs : création, suppression, modification de fiche (les changements d'état passent par apply_status).
create or replace function log_items() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return null; end if;   -- import / maintenance depuis l'éditeur SQL : pas de bruit
  if tg_op = 'INSERT' then perform log_event('PROJECTEUR', format('#%s : projecteur créé (modèle %s)', new.id, new.model_id));
  elsif tg_op = 'DELETE' then perform log_event('PROJECTEUR', format('#%s : projecteur supprimé', old.id));
  elsif (new.model_id, new.lamp_id, new.note, new.last_service) is distinct from (old.model_id, old.lamp_id, old.note, old.last_service) then
    perform log_event('PROJECTEUR', format('#%s : fiche modifiée', new.id));
  end if;
  return null;
end $$;
drop trigger if exists items_log on items;
create trigger items_log after insert or update or delete on items for each row execute function log_items();

-- Catalogue (familles, types, douilles, porte-filtres, lampes, modèles)
create or replace function log_catalogue() returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb := to_jsonb(coalesce(new, old));
begin
  if auth.uid() is null then return null; end if;
  perform log_event('CATALOGUE', format('%s « %s » : %s', tg_table_name, coalesce(r->>'name', r->>'id'),
    case tg_op when 'INSERT' then 'ajouté' when 'DELETE' then 'supprimé' else 'modifié' end));
  return null;
end $$;
do $$ declare t text; begin
  foreach t in array array['families','item_types','sockets','filter_sizes','lamps','models'] loop
    execute format('drop trigger if exists %I on %I', t || '_log', t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function log_catalogue()', t || '_log', t);
  end loop;
end $$;

-- Comptes : changements faits directement en base par un admin connecté (ceux de la fonction admin-users sont journalisés par elle).
create or replace function log_profiles() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return null; end if;
  if new.role is distinct from old.role then perform log_event('COMPTE', format('%s : rôle %s → %s', new.email, old.role, new.role)); end if;
  if new.active is distinct from old.active then perform log_event('COMPTE', format('%s : accès %s', new.email, case when new.active then 'rétabli' else 'révoqué' end)); end if;
  return null;
end $$;
drop trigger if exists profiles_log on profiles;
create trigger profiles_log after update on profiles for each row execute function log_profiles();

-- Temps réel : Supabase diffuse les nouvelles lignes aux administrateurs connectés (si la publication existe).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table app_log;
    exception when duplicate_object then null; end;
  end if;
end $$;

-- Rattrapage : projecteurs déjà en SAV ou en prêt sans aucune période dans l'agenda.
insert into immos (item_id, kind, start_date)
select i.id, case i.status when 'sav' then 'sav' else 'pret' end, (i.status_at at time zone 'Europe/Paris')::date
  from items i
 where i.status in ('sav', 'en_pret') and not exists (select 1 from immos m where m.item_id = i.id);

-- ---------- Sécurité (RLS) --------------------------------------------
alter table profiles     enable row level security;
alter table families     enable row level security;
alter table item_types   enable row level security;
alter table sockets      enable row level security;
alter table filter_sizes enable row level security;
alter table lamps        enable row level security;
alter table models       enable row level security;
alter table items        enable row level security;
alter table faults       enable row level security;
alter table item_events  enable row level security;
alter table fault_log    enable row level security;
alter table app_log      enable row level security;
alter table immos        enable row level security;

-- profils : chacun voit le sien ; régisseurs généraux et admins voient tous les comptes ; seul l'admin modifie directement
drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select using (id = auth.uid() or has_role('regisseur_general'));
drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update using (has_role('admin')) with check (has_role('admin'));

-- lecture : tous les rôles
do $$
declare t text;
begin
  foreach t in array array['families','item_types','sockets','filter_sizes','lamps','models','items'] loop
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format('create policy %I on %I for select using (has_role(''technicien''))', t || '_select', t);
  end loop;
  -- catalogue (familles, types, douilles, porte-filtres, lampes, modèles) : écriture = admin
  foreach t in array array['families','item_types','sockets','filter_sizes','lamps','models'] loop
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format('create policy %I on %I for all using (has_role(''admin'')) with check (has_role(''admin''))', t || '_write', t);
  end loop;
end $$;

-- parc : création = régisseur général ; modification et suppression = admin
-- (le changement d'état passe par la fonction apply_status, réservée au régisseur général)
drop policy if exists items_write on items;
drop policy if exists items_insert on items;
create policy items_insert on items for insert with check (has_role('regisseur_general'));
drop policy if exists items_update on items;
create policy items_update on items for update using (has_role('admin')) with check (has_role('admin'));
drop policy if exists items_delete on items;
create policy items_delete on items for delete using (has_role('admin'));

-- pannes & journal : lecture = tous les rôles ; écritures uniquement via les fonctions ci-dessus (+ admin)
drop policy if exists faults_select on faults;
create policy faults_select on faults for select using (has_role('technicien'));
drop policy if exists fault_log_select on fault_log;
create policy fault_log_select on fault_log for select using (has_role('technicien'));
drop policy if exists immos_select on immos;
create policy immos_select on immos for select using (has_role('technicien'));
drop policy if exists app_log_select on app_log;
create policy app_log_select on app_log for select using (has_role('admin'));
drop policy if exists faults_admin on faults;
create policy faults_admin on faults for all using (has_role('admin')) with check (has_role('admin'));

drop policy if exists item_events_select on item_events;
create policy item_events_select on item_events for select using (has_role('technicien'));

-- droits d'exécution des fonctions
revoke all on function apply_status(uuid,int,item_status,text,timestamptz,text,date,date) from public;
revoke all on function add_immo(uuid,int,text,text,text,date,date,date) from public;
revoke all on function edit_immo(uuid,text,text,date,date,date) from public;
revoke all on function delete_immo(uuid) from public;
revoke all on function report_fault(uuid,int,text,timestamptz) from public;
revoke all on function resolve_fault(uuid,uuid,text,timestamptz) from public;
grant execute on function apply_status(uuid,int,item_status,text,timestamptz,text,date,date) to authenticated;
grant execute on function add_immo(uuid,int,text,text,text,date,date,date) to authenticated;
grant execute on function edit_immo(uuid,text,text,date,date,date) to authenticated;
grant execute on function delete_immo(uuid) to authenticated;
grant execute on function report_fault(uuid,int,text,timestamptz) to authenticated;
grant execute on function resolve_fault(uuid,uuid,text,timestamptz) to authenticated;
revoke all on function add_fault_note(uuid,uuid,text,timestamptz) from public;
revoke all on function edit_fault(uuid,uuid,text,timestamptz) from public;
grant execute on function add_fault_note(uuid,uuid,text,timestamptz) to authenticated;
grant execute on function edit_fault(uuid,uuid,text,timestamptz) to authenticated;
