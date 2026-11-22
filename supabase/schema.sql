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

-- Spectacles : un projecteur assigné à un spectacle est « utilisé » pendant ses dates (état calculé côté appli).
create table if not exists shows (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  start_date       date not null,
  end_date         date not null,
  note             text,
  created_by       uuid references auth.users on delete set null,
  created_by_label text,
  created_at       timestamptz not null default now(),
  constraint shows_dates check (end_date >= start_date)
);
alter table shows add column if not exists color text check (color ~ '^#[0-9a-f]{6}$');
create table if not exists show_items (
  show_id        uuid not null references shows(id) on delete cascade,
  item_id        integer not null references items(id) on delete cascade,
  lamp_id        text references lamps(id) on delete set null,   -- lampe requise (PAR : CP60, CP61, CP62, CP95)
  added_by_label text,
  added_at       timestamptz not null default now(),
  primary key (show_id, item_id)
);
create index if not exists show_items_item_idx on show_items(item_id);
-- Régisseurs assignés à un spectacle : seuls eux (et les régisseurs généraux / admins) peuvent y assigner des projecteurs.
create table if not exists show_regisseurs (
  show_id        uuid not null references shows(id) on delete cascade,
  user_id        uuid not null references auth.users on delete cascade,
  label          text,
  added_by_label text,
  added_at       timestamptz not null default now(),
  primary key (show_id, user_id)
);

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
declare m immos; lbl text; st item_status; want item_status;
begin
  if not has_role('regisseur_general') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  delete from immos where id = p_id returning * into m;
  if not found then return; end if;
  perform log_event('AGENDA', format('#%s : période supprimée', m.item_id));
  -- Supprimer une période en cours remet le projecteur disponible (sans toucher à la date de dernier SAV :
  -- la période est considérée comme n'ayant jamais eu lieu), sauf s'il reste une autre période en cours.
  if m.closed_date is null and m.start_date <= (now() at time zone 'Europe/Paris')::date
     and not exists (select 1 from immos o where o.item_id = m.item_id and o.closed_date is null and o.start_date <= (now() at time zone 'Europe/Paris')::date) then
    select status into st from items where id = m.item_id;
    want := (case m.kind when 'pret' then 'en_pret' else 'sav' end)::item_status;
    if st = want then
      select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
      update items set status = 'dispo', status_at = now(), updated_at = now() where id = m.item_id;
      insert into item_events (id, item_id, kind, status, note, created_by, created_by_label, at)
      values (gen_random_uuid(), m.item_id, 'status', 'dispo', 'période supprimée', auth.uid(), lbl, now());
      perform log_event('STATUT', format('#%s : %s → dispo (période supprimée)', m.item_id, status_label(st)));
    end if;
  end if;
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


-- Spectacles : conflits, création, modification, assignation.
-- Un projecteur ne peut pas être dans deux spectacles aux dates qui se recoupent, ni sur une période de prêt / SAV
-- (un SAV sans date de fin connue le bloque tant qu'on n'a pas indiqué sa fin prévue).
create or replace function item_conflict(p_item int, p_show uuid, p_start date, p_end date) returns text
language plpgsql stable security definer set search_path = public as $$
declare r text;
begin
  select 'déjà dans « ' || s.name || ' » (' || to_char(s.start_date, 'DD/MM') || ' → ' || to_char(s.end_date, 'DD/MM') || ')' into r
    from show_items si join shows s on s.id = si.show_id
   where si.item_id = p_item and s.id is distinct from p_show and s.start_date <= p_end and s.end_date >= p_start limit 1;
  if r is not null then return r; end if;
  select (case m.kind when 'pret' then 'prêt' else 'SAV' end) || coalesce(' (' || m.who || ')', '') || ' du ' || to_char(m.start_date, 'DD/MM')
         || coalesce(' au ' || to_char(coalesce(m.closed_date, m.end_date), 'DD/MM'), ' (fin non connue)') into r
    from immos m
   where m.item_id = p_item and m.start_date <= p_end and coalesce(m.closed_date, m.end_date, 'infinity'::date) >= p_start limit 1;
  return r;
end $$;

-- Couleurs des spectacles : palette fixe ; deux spectacles qui se suivent (ou se chevauchent) n'ont jamais la même couleur.
create or replace function show_palette() returns text[] language sql immutable as $$
  select array['#1d4ed8','#0f766e','#7e22ce','#c2410c','#be185d','#4d7c0f','#78350f','#4338ca','#475569','#0e7490'];
$$;

-- Nom du spectacle voisin (précédent, suivant ou en chevauchement) qui porte déjà cette couleur, sinon null.
create or replace function show_color_clash(p_id uuid, p_start date, p_end date, p_color text) returns text
language plpgsql stable security definer set search_path = public as $$
declare r text; prev uuid; nxt uuid;
begin
  select id into prev from shows where id is distinct from p_id and start_date <= p_start order by start_date desc, end_date desc limit 1;
  select id into nxt  from shows where id is distinct from p_id and start_date >  p_start order by start_date asc  limit 1;
  select name into r from shows
   where id is distinct from p_id and color = p_color
     and (id = prev or id = nxt or (start_date <= p_end and end_date >= p_start)) limit 1;
  return r;
end $$;

create or replace function pick_show_color(p_id uuid, p_start date, p_end date) returns text
language plpgsql stable security definer set search_path = public as $$
declare pal text[] := show_palette(); n int := array_length(show_palette(), 1); k int; c text; off int;
begin
  select count(*) % n into off from shows where id is distinct from p_id;
  for k in 0 .. n - 1 loop
    c := pal[((off + k) % n) + 1];
    if show_color_clash(p_id, p_start, p_end, c) is null then return c; end if;
  end loop;
  return pal[off + 1];
end $$;

-- spectacles existants sans couleur : attribution dans l'ordre chronologique
do $$ declare r record; begin
  for r in select id, start_date, end_date from shows where color is null order by start_date, created_at loop
    update shows set color = pick_show_color(r.id, r.start_date, r.end_date) where id = r.id;
  end loop;
end $$;

drop function if exists create_show(uuid,text,date,date,text);
drop function if exists edit_show(uuid,text,date,date,text);

create or replace function create_show(p_id uuid, p_name text, p_start date, p_end date, p_note text, p_color text default null) returns void
language plpgsql security definer set search_path = public as $$
declare lbl text; n int; col text; c text;
begin
  if not has_role('regisseur_general') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Nom obligatoire' using errcode = '22023'; end if;
  if p_color is not null and not (p_color = any (show_palette())) then raise exception 'Couleur inconnue' using errcode = '22023'; end if;
  col := coalesce(p_color, pick_show_color(p_id, p_start, p_end));
  c := show_color_clash(p_id, p_start, p_end, col);
  if c is not null then raise exception 'Cette couleur est déjà celle de « % », qui précède, suit ou chevauche ce spectacle', c using errcode = '22023'; end if;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  insert into shows (id, name, start_date, end_date, note, color, created_by, created_by_label)
  values (p_id, trim(p_name), p_start, p_end, nullif(trim(p_note), ''), col, auth.uid(), lbl) on conflict (id) do nothing;
  get diagnostics n = row_count;
  if n > 0 then perform log_event('SPECTACLE', format('« %s » créé (%s → %s)', trim(p_name), to_char(p_start, 'DD/MM/YYYY'), to_char(p_end, 'DD/MM/YYYY'))); end if;
end $$;

-- p_color null = on garde la couleur actuelle (recalculée automatiquement si les nouvelles dates créent un conflit).
create or replace function edit_show(p_id uuid, p_name text, p_start date, p_end date, p_note text, p_color text default null) returns void
language plpgsql security definer set search_path = public as $$
declare c text; col text;
begin
  if not has_role('regisseur_general') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Nom obligatoire' using errcode = '22023'; end if;
  if p_color is not null and not (p_color = any (show_palette())) then raise exception 'Couleur inconnue' using errcode = '22023'; end if;
  -- les nouvelles dates ne doivent pas recouvrir un autre spectacle pour les projecteurs déjà assignés
  select 'Nouvelles dates impossibles : #' || si.item_id || ' est déjà dans « ' || o.name || ' » (' || to_char(o.start_date, 'DD/MM') || ' → ' || to_char(o.end_date, 'DD/MM') || ')' into c
    from show_items si join show_items sj on sj.item_id = si.item_id and sj.show_id <> p_id join shows o on o.id = sj.show_id
   where si.show_id = p_id and o.start_date <= p_end and o.end_date >= p_start limit 1;
  if c is not null then raise exception '%', c using errcode = '22023'; end if;
  select color into col from shows where id = p_id;
  if not found then raise exception 'Spectacle introuvable' using errcode = '22023'; end if;
  if p_color is not null then
    c := show_color_clash(p_id, p_start, p_end, p_color);
    if c is not null then raise exception 'Cette couleur est déjà celle de « % », qui précède, suit ou chevauche ce spectacle', c using errcode = '22023'; end if;
    col := p_color;
  elsif col is null or show_color_clash(p_id, p_start, p_end, col) is not null then
    col := pick_show_color(p_id, p_start, p_end);
  end if;
  update shows set name = trim(p_name), start_date = p_start, end_date = p_end, note = nullif(trim(p_note), ''), color = col where id = p_id;
  perform reallocate_all();
  perform log_event('SPECTACLE', format('« %s » modifié (%s → %s)', trim(p_name), to_char(p_start, 'DD/MM/YYYY'), to_char(p_end, 'DD/MM/YYYY')));
end $$;

create or replace function delete_show(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare nm text;
begin
  if not has_role('regisseur_general') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  delete from shows where id = p_id returning name into nm;
  if found then perform log_event('SPECTACLE', format('« %s » supprimé', nm)); end if;
  perform reallocate_all();
end $$;

-- Gélatines : plusieurs gels possibles par projecteur d'un spectacle (le format vient du porte-filtre du modèle).
create table if not exists show_gels (
  id             uuid primary key default gen_random_uuid(),
  show_id        uuid not null,
  item_id        int  not null,
  ref            text not null check (length(trim(ref)) between 1 and 60),
  color          text not null,
  added_by_label text,
  added_at       timestamptz not null default now(),
  foreign key (show_id, item_id) references show_items(show_id, item_id) on delete cascade
);
create index if not exists show_gels_show_idx on show_gels(show_id);
alter table show_gels enable row level security;
drop policy if exists show_gels_select on show_gels;
create policy show_gels_select on show_gels for select using (has_role('technicien'));

create or replace function gel_colors() returns text[] language sql immutable as $$
  select array['Rouge','Orange','Ambre','Jaune','Vert','Bleu','Violet','Rose','Correction (CTO/CTB)','Diffusion','Neutre (ND)','Autre'];
$$;

-- Ajoute le même gel à un ou plusieurs projecteurs d'un spectacle (ceux qui n'y sont pas assignés sont ignorés).
create or replace function add_gels(p_show uuid, p_items int[], p_ref text, p_color text) returns int
language plpgsql security definer set search_path = public as $$
declare lbl text; n int; nm text;
begin
  if not can_act_show(p_show) then raise exception 'Droits insuffisants : tu n''es pas assigné à ce spectacle' using errcode = '42501'; end if;
  if nullif(trim(p_ref), '') is null or length(trim(p_ref)) > 60 then raise exception 'Référence du gel obligatoire (60 caractères maximum)' using errcode = '22023'; end if;
  if not (p_color = any (gel_colors())) then raise exception 'Couleur de gel inconnue' using errcode = '22023'; end if;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  insert into show_gels (show_id, item_id, ref, color, added_by_label)
  select p_show, si.item_id, trim(p_ref), p_color, lbl from show_items si where si.show_id = p_show and si.item_id = any (p_items);
  get diagnostics n = row_count;
  select name into nm from shows where id = p_show;
  if n > 0 then perform log_event('SPECTACLE', format('« %s » : gel %s (%s) ajouté sur %s projecteur(s) (%s)', nm, trim(p_ref), p_color, n, array_to_string(p_items, ', '))); end if;
  return n;
end $$;

create or replace function delete_gel(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare g show_gels; nm text;
begin
  select * into g from show_gels where id = p_id;
  if not found then return; end if;
  if not can_act_show(g.show_id) then raise exception 'Droits insuffisants : tu n''es pas assigné à ce spectacle' using errcode = '42501'; end if;
  delete from show_gels where id = p_id;
  select name into nm from shows where id = g.show_id;
  perform log_event('SPECTACLE', format('« %s » : gel %s retiré du projecteur %s', nm, g.ref, g.item_id));
end $$;

-- Mur du spectacle : messages signés, modifiables / effaçables par leur auteur.
create table if not exists show_posts (
  id           uuid primary key,
  show_id      uuid not null references shows(id) on delete cascade,
  author_id    uuid references auth.users on delete set null,
  author_label text,
  body         text not null check (length(trim(body)) > 0 and length(body) <= 2000),
  created_at   timestamptz not null default now(),
  edited_at    timestamptz
);
create index if not exists show_posts_show_idx on show_posts(show_id, created_at desc);
alter table show_posts enable row level security;
drop policy if exists show_posts_select on show_posts;
create policy show_posts_select on show_posts for select using (has_role('technicien'));

create or replace function post_show_message(p_id uuid, p_show uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare lbl text;
begin
  if not has_role('technicien') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  if not exists (select 1 from shows where id = p_show) then raise exception 'Spectacle introuvable' using errcode = '22023'; end if;
  if nullif(trim(p_body), '') is null then raise exception 'Message vide' using errcode = '22023'; end if;
  if length(p_body) > 2000 then raise exception 'Message trop long (2000 caractères maximum)' using errcode = '22023'; end if;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  insert into show_posts (id, show_id, author_id, author_label, body) values (p_id, p_show, auth.uid(), lbl, trim(p_body)) on conflict (id) do nothing;
end $$;

create or replace function edit_show_message(p_id uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare a uuid;
begin
  select author_id into a from show_posts where id = p_id;
  if not found then raise exception 'Message introuvable' using errcode = '22023'; end if;
  if a is distinct from auth.uid() then raise exception 'Tu ne peux modifier que tes propres messages' using errcode = '42501'; end if;
  if nullif(trim(p_body), '') is null then raise exception 'Message vide' using errcode = '22023'; end if;
  if length(p_body) > 2000 then raise exception 'Message trop long (2000 caractères maximum)' using errcode = '22023'; end if;
  update show_posts set body = trim(p_body), edited_at = now() where id = p_id;
end $$;

-- Messages généraux (v1.11) : sans spectacle. Un administrateur poste une « annonce admin » (notes de mise à jour…),
-- un régisseur général une « info générale » (vie du théâtre, usage du matériel…). Le bandeau est fixé par le rôle de l'auteur.
alter table show_posts alter column show_id drop not null;
alter table show_posts add column if not exists kind text not null default 'show';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'show_posts_kind_ck') then
    alter table show_posts add constraint show_posts_kind_ck check ((kind = 'show' and show_id is not null) or (kind in ('admin', 'general') and show_id is null));
  end if;
end $$;
create or replace function post_general_message(p_id uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare lbl text; k text;
begin
  if not has_role('regisseur_general') then raise exception 'Réservé aux régisseurs généraux et aux administrateurs' using errcode = '42501'; end if;
  if nullif(trim(p_body), '') is null then raise exception 'Message vide' using errcode = '22023'; end if;
  if length(p_body) > 2000 then raise exception 'Message trop long (2000 caractères maximum)' using errcode = '22023'; end if;
  k := case when has_role('admin') then 'admin' else 'general' end;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  insert into show_posts (id, show_id, kind, author_id, author_label, body) values (p_id, null, k, auth.uid(), lbl, trim(p_body)) on conflict (id) do nothing;
end $$;

-- Effacer : l'auteur, ou un administrateur (modération).
create or replace function delete_show_message(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a uuid;
begin
  select author_id into a from show_posts where id = p_id;
  if not found then return; end if;
  if a is distinct from auth.uid() and not has_role('admin') then raise exception 'Tu ne peux effacer que tes propres messages' using errcode = '42501'; end if;
  delete from show_posts where id = p_id;
end $$;

-- Chacun peut changer son propre prénom / nom (les signatures du mur et la liste des régisseurs suivent).
create or replace function set_my_name(p_first text, p_last text) returns void
language plpgsql security definer set search_path = public as $$
declare f text := trim(coalesce(p_first, '')); l text := trim(coalesce(p_last, '')); lbl text;
begin
  if auth.uid() is null or not has_role('technicien') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  if f = '' or l = '' then raise exception 'Prénom et nom obligatoires' using errcode = '22023'; end if;
  if length(f) > 60 or length(l) > 60 then raise exception 'Nom trop long (60 caractères maximum)' using errcode = '22023'; end if;
  update profiles set first_name = f, last_name = l where id = auth.uid();
  lbl := f || ' ' || l;
  update show_posts set author_label = lbl where author_id = auth.uid();
  update show_regisseurs set label = lbl where user_id = auth.uid();
end $$;

-- Annuaire minimal pour citer une personne (nom seulement, comptes actifs).
create or replace function list_people() returns table(id uuid, label text)
language sql stable security definer set search_path = public as $$
  select p.id, coalesce(nullif(trim(p.first_name || ' ' || p.last_name), ''), p.email)
    from profiles p where has_role('technicien') and p.active order by 2;
$$;

-- Peut agir sur un spectacle : régisseur général / admin, ou régisseur assigné à ce spectacle.
create or replace function can_act_show(p_show uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_role('regisseur_general')
      or (has_role('regisseur') and exists (select 1 from show_regisseurs where show_id = p_show and user_id = auth.uid()));
$$;

-- Assigne / retire un régisseur d'un spectacle (régisseur général et admin).
create or replace function assign_regisseur(p_show uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s shows; u profiles; lbl text; n int;
begin
  if not has_role('regisseur_general') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  select * into s from shows where id = p_show;
  if not found then raise exception 'Spectacle introuvable' using errcode = '22023'; end if;
  select * into u from profiles where id = p_user;
  if not found or not u.active then raise exception 'Compte introuvable ou désactivé' using errcode = '22023'; end if;
  if role_rank(u.role) < role_rank('regisseur') then raise exception 'Seul un régisseur (ou plus) peut être assigné' using errcode = '22023'; end if;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  insert into show_regisseurs (show_id, user_id, label, added_by_label)
  values (p_show, p_user, coalesce(nullif(trim(u.first_name || ' ' || u.last_name), ''), u.email), lbl) on conflict do nothing;
  get diagnostics n = row_count;
  if n > 0 then perform log_event('SPECTACLE', format('« %s » : %s assigné(e) comme régisseur', s.name, coalesce(nullif(trim(u.first_name || ' ' || u.last_name), ''), u.email))); end if;
end $$;

create or replace function unassign_regisseur(p_show uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare nm text; who text;
begin
  if not has_role('regisseur_general') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  delete from show_regisseurs where show_id = p_show and user_id = p_user returning label into who;
  if found then
    select name into nm from shows where id = p_show;
    perform log_event('SPECTACLE', format('« %s » : %s n''est plus régisseur du spectacle', nm, who));
  end if;
end $$;

-- Assigne des projecteurs (ceux qui posent problème sont ignorés et renvoyés avec la raison).
create or replace function assign_items(p_show uuid, p_items int[], p_lamp text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s shows; it int; c text; added int[] := '{}'; skipped jsonb := '[]'::jsonb; ispar boolean; lbl text;
begin
  if not can_act_show(p_show) then raise exception 'Droits insuffisants : tu n''es pas assigné à ce spectacle' using errcode = '42501'; end if;
  select * into s from shows where id = p_show;
  if not found then raise exception 'Spectacle introuvable' using errcode = '22023'; end if;
  if p_lamp is not null and not exists (select 1 from lamps where id = p_lamp) then raise exception 'Lampe inconnue' using errcode = '22023'; end if;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  foreach it in array (select coalesce(array_agg(distinct x), '{}') from unnest(p_items) x) loop
    if not exists (select 1 from items where id = it) then skipped := skipped || jsonb_build_object('item', it, 'reason', 'introuvable'); continue; end if;
    select exists (select 1 from items i join models m on m.id = i.model_id join item_types t on t.id = m.type_id where i.id = it and t.name ilike 'PAR%') into ispar;
    if ispar and p_lamp is null and not exists (select 1 from show_items where show_id = p_show and item_id = it and lamp_id is not null) then
      skipped := skipped || jsonb_build_object('item', it, 'reason', 'lampe requise (PAR)'); continue; end if;
    c := item_conflict(it, p_show, s.start_date, s.end_date);
    if c is not null then skipped := skipped || jsonb_build_object('item', it, 'reason', c); continue; end if;
    insert into show_items (show_id, item_id, lamp_id, added_by_label)
    values (p_show, it, case when ispar then p_lamp end, lbl)
    on conflict (show_id, item_id) do update set lamp_id = coalesce(case when ispar then excluded.lamp_id end, show_items.lamp_id), pinned = (show_items.demand_id is not null);
    added := added || it;
  end loop;
  if cardinality(added) > 0 then
    perform log_event('SPECTACLE', format('« %s » : %s projecteur(s) assigné(s) (%s)', s.name, cardinality(added), array_to_string(added, ', ')));
  end if;
  perform reallocate_all();
  return jsonb_build_object('added', to_jsonb(added), 'skipped', skipped);
end $$;

create or replace function unassign_items(p_show uuid, p_items int[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int; nm text;
begin
  if not can_act_show(p_show) then raise exception 'Droits insuffisants : tu n''es pas assigné à ce spectacle' using errcode = '42501'; end if;
  delete from show_items where show_id = p_show and item_id = any(p_items);
  get diagnostics n = row_count;
  select name into nm from shows where id = p_show;
  if n > 0 then perform log_event('SPECTACLE', format('« %s » : %s projecteur(s) retiré(s) (%s)', nm, n, array_to_string(p_items, ', '))); end if;
  perform reallocate_all();
  return n;
end $$;

-- Projecteurs : création, suppression, modification de fiche (les changements d'état passent par apply_status).
create or replace function log_items() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return null; end if;   -- import / maintenance depuis l'éditeur SQL : pas de bruit
  if tg_op = 'INSERT' then perform log_event('PROJECTEUR', format('#%s : projecteur créé (modèle %s)', new.id, new.model_id));
  elsif tg_op = 'DELETE' then perform log_event('PROJECTEUR', format('#%s : projecteur supprimé', old.id));
  elsif coalesce(current_setting('app.lamp_change', true), '') = '1' then null;   -- changement de lampe : déjà journalisé par set_lamp
  elsif (new.model_id, new.lamp_id, new.note, new.last_service) is distinct from (old.model_id, old.lamp_id, old.note, old.last_service) then
    perform log_event('PROJECTEUR', format('#%s : fiche modifiée', new.id));
  end if;
  return null;
end $$;
drop trigger if exists items_log on items;
create trigger items_log after insert or update or delete on items for each row execute function log_items();

-- Changement de lampe d'un PAR (CP60, CP61, CP62, CP95…) : ouvert dès le technicien.
create or replace function set_lamp(p_item int, p_lamp text) returns void
language plpgsql security definer set search_path = public as $$
declare it items; lm lamps; ty text; old_name text;
begin
  if not has_role('technicien') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  select * into it from items where id = p_item;
  if not found then raise exception 'Projecteur % introuvable', p_item using errcode = '22023'; end if;
  select * into lm from lamps where id = p_lamp;
  if not found or lm.name !~* '^CP[0-9]+' then raise exception 'Lampe inconnue' using errcode = '22023'; end if;
  select t.name into ty from models m join item_types t on t.id = m.type_id where m.id = it.model_id;
  if ty is null or ty !~* '^PAR' then raise exception 'Le changement rapide de lampe ne concerne que les PAR' using errcode = '22023'; end if;
  if it.lamp_id is not distinct from p_lamp then return; end if;
  select name into old_name from lamps where id = it.lamp_id;
  perform set_config('app.lamp_change', '1', true);
  update items set lamp_id = p_lamp, updated_at = now() where id = p_item;
  perform set_config('app.lamp_change', '', true);
  perform log_event('PROJECTEUR', format('#%s : lampe %s → %s', p_item, coalesce(old_name, '—'), lm.name));
end $$;

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
alter table shows        enable row level security;
alter table show_items   enable row level security;
alter table show_regisseurs enable row level security;

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
drop policy if exists shows_select on shows;
create policy shows_select on shows for select using (has_role('technicien'));
drop policy if exists show_items_select on show_items;
create policy show_items_select on show_items for select using (has_role('technicien'));
drop policy if exists show_regisseurs_select on show_regisseurs;
create policy show_regisseurs_select on show_regisseurs for select using (has_role('technicien'));
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
revoke all on function item_conflict(int,uuid,date,date) from public;
revoke all on function create_show(uuid,text,date,date,text,text) from public;
revoke all on function edit_show(uuid,text,date,date,text,text) from public;
revoke all on function show_color_clash(uuid,date,date,text) from public;
revoke all on function pick_show_color(uuid,date,date) from public;
revoke all on function delete_show(uuid) from public;
revoke all on function assign_items(uuid,int[],text) from public;
revoke all on function unassign_items(uuid,int[]) from public;
revoke all on function can_act_show(uuid) from public;
revoke all on function add_gels(uuid,int[],text,text) from public;
revoke all on function delete_gel(uuid) from public;
revoke all on function post_general_message(uuid,text) from public;
revoke all on function post_show_message(uuid,uuid,text) from public;
revoke all on function edit_show_message(uuid,text) from public;
revoke all on function delete_show_message(uuid) from public;
revoke all on function list_people() from public;
revoke all on function set_my_name(text,text) from public;
revoke all on function set_lamp(int,text) from public;
revoke all on function assign_regisseur(uuid,uuid) from public;
revoke all on function unassign_regisseur(uuid,uuid) from public;
revoke all on function report_fault(uuid,int,text,timestamptz) from public;
revoke all on function resolve_fault(uuid,uuid,text,timestamptz) from public;
grant execute on function apply_status(uuid,int,item_status,text,timestamptz,text,date,date) to authenticated;
grant execute on function add_immo(uuid,int,text,text,text,date,date,date) to authenticated;
grant execute on function edit_immo(uuid,text,text,date,date,date) to authenticated;
grant execute on function delete_immo(uuid) to authenticated;
grant execute on function create_show(uuid,text,date,date,text,text) to authenticated;
grant execute on function edit_show(uuid,text,date,date,text,text) to authenticated;
grant execute on function delete_show(uuid) to authenticated;
grant execute on function assign_items(uuid,int[],text) to authenticated;
grant execute on function unassign_items(uuid,int[]) to authenticated;
grant execute on function can_act_show(uuid) to authenticated;
grant execute on function add_gels(uuid,int[],text,text) to authenticated;
grant execute on function delete_gel(uuid) to authenticated;
grant execute on function post_general_message(uuid,text) to authenticated;
grant execute on function post_show_message(uuid,uuid,text) to authenticated;
grant execute on function edit_show_message(uuid,text) to authenticated;
grant execute on function delete_show_message(uuid) to authenticated;
grant execute on function list_people() to authenticated;
grant execute on function set_my_name(text,text) to authenticated;
grant execute on function set_lamp(int,text) to authenticated;
grant execute on function assign_regisseur(uuid,uuid) to authenticated;
grant execute on function unassign_regisseur(uuid,uuid) to authenticated;
grant execute on function report_fault(uuid,int,text,timestamptz) to authenticated;
grant execute on function resolve_fault(uuid,uuid,text,timestamptz) to authenticated;
revoke all on function add_fault_note(uuid,uuid,text,timestamptz) from public;
revoke all on function edit_fault(uuid,uuid,text,timestamptz) from public;
grant execute on function add_fault_note(uuid,uuid,text,timestamptz) to authenticated;
grant execute on function edit_fault(uuid,uuid,text,timestamptz) to authenticated;

-- ======================= Assignation automatique (v1.9) =======================
-- Un spectacle exprime des DEMANDES (modèle + lampe pour les PAR + quantité) ; l'appli choisit les projecteurs.
-- Elle préfère les PAR déjà montés avec la bonne lampe, évite les projecteurs indisponibles (SAV, prêt, panne ouverte,
-- autre spectacle aux mêmes dates) et se remet à jour à chaque changement. Les choix manuels (« épinglés ») sont conservés.
alter table show_items add column if not exists demand_id uuid;
alter table show_items add column if not exists pinned boolean not null default false;   -- choisi à la main (jamais réassigné)
alter table show_items add column if not exists problem text;                              -- raison d'indisponibilité, sinon null
create table if not exists show_demands (
  id             uuid primary key default gen_random_uuid(),
  show_id        uuid not null references shows(id) on delete cascade,
  model_id       text not null references models(id),
  lamp_id        text references lamps(id) on delete set null,   -- PAR : lampe demandée
  qty            int  not null check (qty between 1 and 500),
  missing        int  not null default 0,                         -- nombre de projecteurs que l'on n'arrive pas à fournir
  added_by_label text,
  added_at       timestamptz not null default now()
);
create unique index if not exists show_demands_uq on show_demands (show_id, model_id, (coalesce(lamp_id, '')));
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'show_items_demand_fk') then
    alter table show_items add constraint show_items_demand_fk foreign key (demand_id) references show_demands(id) on delete set null;
  end if;
end $$;
-- Matériel prêté / loué pour combler un manque : une fiche par prêt ou location (quantité, prêteur / loueur, livraison, reprise).
create table if not exists show_externals (
  id             uuid primary key default gen_random_uuid(),
  show_id        uuid not null references shows(id) on delete cascade,
  demand_id      uuid not null references show_demands(id) on delete cascade,
  kind           text not null check (kind in ('pret', 'location')),
  provider       text not null check (length(trim(provider)) between 1 and 80),
  qty            int  not null check (qty between 1 and 500),
  delivery_date  date not null,
  return_date    date not null,
  note           text,
  added_by_label text,
  added_at       timestamptz not null default now(),
  constraint show_externals_dates check (return_date >= delivery_date)
);
create index if not exists show_externals_show_idx on show_externals(show_id);
alter table show_externals enable row level security;
drop policy if exists show_externals_select on show_externals;
create policy show_externals_select on show_externals for select using (has_role('technicien'));
alter table show_demands enable row level security;
drop policy if exists show_demands_select on show_demands;
create policy show_demands_select on show_demands for select using (has_role('technicien'));

-- Raison pour laquelle un projecteur ne peut pas être utilisé par un spectacle (null = utilisable).
-- p_auto : pour l'allocation automatique, les lignes automatiques des spectacles moins prioritaires (début plus tardif) ne comptent pas.
create or replace function item_blocked(p_item int, p_show uuid, p_start date, p_end date, p_auto boolean default false) returns text
language plpgsql stable security definer set search_path = public as $$
declare r text; me shows;
begin
  select * into me from shows where id = p_show;
  select 'déjà dans « ' || s.name || ' » (' || to_char(s.start_date, 'DD/MM') || ' → ' || to_char(s.end_date, 'DD/MM') || ')' into r
    from show_items si join shows s on s.id = si.show_id
   where si.item_id = p_item and s.id is distinct from p_show and s.start_date <= p_end and s.end_date >= p_start
     and (not p_auto or si.pinned or si.demand_id is null or (s.start_date, s.id) < (me.start_date, me.id)) limit 1;
  if r is not null then return r; end if;
  select (case m.kind when 'pret' then 'prêt' else 'SAV' end) || coalesce(' (' || m.who || ')', '') || ' du ' || to_char(m.start_date, 'DD/MM')
         || coalesce(' au ' || to_char(coalesce(m.closed_date, m.end_date), 'DD/MM'), ' (fin non connue)') into r
    from immos m
   where m.item_id = p_item and m.start_date <= p_end and coalesce(m.closed_date, m.end_date, 'infinity'::date) >= p_start limit 1;
  if r is not null then return r; end if;
  if exists (select 1 from faults f where f.item_id = p_item and f.resolved_at is null) then return 'en panne'; end if;
  return null;
end $$;

-- Recalcule les projecteurs automatiques d'un spectacle.
create or replace function reallocate_show(p_show uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s shows; d show_demands; ispar boolean; prev int[]; ch_item int[] := '{}'; ch_dem uuid[] := '{}'; k int;
  pv int; need int; pick int[]; chosen_for int; passn int;
begin
  select * into s from shows where id = p_show;
  if not found then return; end if;
  select coalesce(array_agg(item_id), '{}') into prev from show_items where show_id = p_show and demand_id is not null and not pinned;
  -- passe 1 : uniquement les projecteurs déjà bien équipés ; passe 2 : on complète avec n'importe quel projecteur disponible
  for passn in 1..2 loop
    for d in select * from show_demands where show_id = p_show order by added_at, id loop
      select exists (select 1 from models m join item_types t on t.id = m.type_id where m.id = d.model_id and t.name ilike 'PAR%') into ispar;
      if passn = 2 and not (ispar and d.lamp_id is not null) then continue; end if;
      select count(*) into pv from show_items si where si.show_id = p_show and si.demand_id = d.id and si.pinned
         and item_blocked(si.item_id, p_show, s.start_date, s.end_date, true) is null;
      select count(*) into chosen_for from unnest(ch_dem) x where x = d.id;
      need := d.qty - pv - chosen_for;
      if need <= 0 then continue; end if;
      select coalesce(array_agg(i.id), '{}') into pick from (
        select i.id from items i
         where i.model_id = d.model_id
           and not (i.id = any (ch_item))
           and (passn = 2 or not (ispar and d.lamp_id is not null) or i.lamp_id = d.lamp_id)
           and not exists (select 1 from show_items x where x.show_id = p_show and x.item_id = i.id and (x.demand_id is null or x.pinned))
           and item_blocked(i.id, p_show, s.start_date, s.end_date, true) is null
         order by (case when i.id = any (prev) then 0 else 1 end), i.id
         limit need) i;
      foreach k in array pick loop ch_item := ch_item || k; ch_dem := ch_dem || d.id; end loop;
    end loop;
  end loop;
  delete from show_items where show_id = p_show and demand_id is not null and not pinned and not (item_id = any (ch_item));
  for k in 1 .. coalesce(cardinality(ch_item), 0) loop
    select * into d from show_demands where id = ch_dem[k];
    insert into show_items (show_id, item_id, lamp_id, demand_id, pinned, added_by_label)
    values (p_show, ch_item[k], d.lamp_id, d.id, false, 'auto')
    on conflict (show_id, item_id) do update set lamp_id = excluded.lamp_id, demand_id = excluded.demand_id where not show_items.pinned and show_items.demand_id is not null;
  end loop;
  -- problèmes (projecteur assigné mais indisponible) et manques
  update show_items si set problem = item_blocked(si.item_id, p_show, s.start_date, s.end_date, true) where si.show_id = p_show;
  update show_demands dd set missing = greatest(0, dd.qty
      - (select count(*) from show_items si where si.show_id = p_show and si.demand_id = dd.id and si.problem is null)
      - coalesce((select sum(e.qty) from show_externals e where e.demand_id = dd.id), 0))
   where dd.show_id = p_show;
end $$;

-- Tous les spectacles à venir ou en cours, dans l'ordre de priorité (début le plus proche d'abord).
create or replace function reallocate_all() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id from shows where end_date >= current_date order by start_date, id loop perform reallocate_show(r.id); end loop;
end $$;

create or replace function reallocate_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin perform reallocate_all(); return null; end $$;
drop trigger if exists items_realloc on items;
create trigger items_realloc after insert or delete on items for each statement execute function reallocate_trg();
drop trigger if exists items_realloc_u on items;
create trigger items_realloc_u after update of status, lamp_id, model_id on items for each statement execute function reallocate_trg();
drop trigger if exists immos_realloc on immos;
create trigger immos_realloc after insert or update or delete on immos for each statement execute function reallocate_trg();
drop trigger if exists faults_realloc on faults;
create trigger faults_realloc after insert or update or delete on faults for each statement execute function reallocate_trg();

-- Demande de matériel : crée, modifie la quantité (0 = supprime) ou remplace la demande identique.
create or replace function set_demand(p_show uuid, p_model text, p_lamp text, p_qty int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ispar boolean; lbl text; nm text; mn text; id_ uuid; miss int; lp text;
begin
  if not can_act_show(p_show) then raise exception 'Droits insuffisants : tu n''es pas assigné à ce spectacle' using errcode = '42501'; end if;
  select name into nm from shows where id = p_show;
  if not found then raise exception 'Spectacle introuvable' using errcode = '22023'; end if;
  select m.name, exists (select 1 from item_types t where t.id = m.type_id and t.name ilike 'PAR%') into mn, ispar from models m where m.id = p_model;
  if mn is null then raise exception 'Modèle inconnu' using errcode = '22023'; end if;
  if ispar then
    if p_lamp is null or not exists (select 1 from lamps where id = p_lamp) then raise exception 'Lampe requise pour un PAR' using errcode = '22023'; end if;
  else p_lamp := null; end if;
  if p_qty is null or p_qty < 0 or p_qty > 500 then raise exception 'Quantité invalide' using errcode = '22023'; end if;
  select id into id_ from show_demands where show_id = p_show and model_id = p_model and coalesce(lamp_id, '') = coalesce(p_lamp, '');
  select name into lp from lamps where id = p_lamp;
  if p_qty = 0 then
    if id_ is not null then
      delete from show_items where show_id = p_show and demand_id = id_ and not pinned;
      delete from show_demands where id = id_;
    end if;
    perform log_event('SPECTACLE', format('« %s » : demande %s%s supprimée', nm, mn, coalesce(' ' || lp, '')));
  else
    select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
    if id_ is null then
      insert into show_demands (show_id, model_id, lamp_id, qty, added_by_label) values (p_show, p_model, p_lamp, p_qty, lbl) returning id into id_;
    else update show_demands set qty = p_qty where id = id_; end if;
    perform log_event('SPECTACLE', format('« %s » : demande %s × %s%s', nm, p_qty, mn, coalesce(' ' || lp, '')));
  end if;
  perform reallocate_all();
  select coalesce(sum(missing), 0)::int into miss from show_demands where show_id = p_show;
  return jsonb_build_object('missing', miss);
end $$;

-- Remplace un projecteur choisi automatiquement par un autre du même modèle ; ce choix est « épinglé » (plus jamais réassigné).
create or replace function swap_show_item(p_show uuid, p_old int, p_new int) returns void
language plpgsql security definer set search_path = public as $$
declare o show_items; s shows; c text; m1 text; m2 text; lbl text;
begin
  if not can_act_show(p_show) then raise exception 'Droits insuffisants : tu n''es pas assigné à ce spectacle' using errcode = '42501'; end if;
  select * into s from shows where id = p_show;
  select * into o from show_items where show_id = p_show and item_id = p_old;
  if not found or o.demand_id is null then raise exception 'Ce projecteur n''est pas issu d''une demande' using errcode = '22023'; end if;
  select model_id into m1 from items where id = p_old;
  select model_id into m2 from items where id = p_new;
  if m2 is null then raise exception 'Projecteur introuvable' using errcode = '22023'; end if;
  if m1 is distinct from m2 then raise exception 'Il faut choisir un projecteur du même modèle' using errcode = '22023'; end if;
  if p_new = p_old then return; end if;
  if exists (select 1 from show_items where show_id = p_show and item_id = p_new) then raise exception 'Déjà dans ce spectacle' using errcode = '22023'; end if;
  c := item_conflict(p_new, p_show, s.start_date, s.end_date);
  if c is not null then raise exception '%', c using errcode = '22023'; end if;
  if exists (select 1 from faults where item_id = p_new and resolved_at is null) then raise exception 'En panne' using errcode = '22023'; end if;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  insert into show_items (show_id, item_id, lamp_id, demand_id, pinned, added_by_label) values (p_show, p_new, o.lamp_id, o.demand_id, true, lbl);
  update show_gels set item_id = p_new where show_id = p_show and item_id = p_old;
  delete from show_items where show_id = p_show and item_id = p_old;
  perform log_event('SPECTACLE', format('« %s » : #%s remplacé par #%s', s.name, p_old, p_new));
  perform reallocate_all();
end $$;

-- Rend un projecteur épinglé à l'assignation automatique.
create or replace function release_show_item(p_show uuid, p_item int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_act_show(p_show) then raise exception 'Droits insuffisants : tu n''es pas assigné à ce spectacle' using errcode = '42501'; end if;
  update show_items set pinned = false where show_id = p_show and item_id = p_item and demand_id is not null;
  perform reallocate_all();
end $$;

create or replace function add_external(p_show uuid, p_demand uuid, p_kind text, p_provider text, p_qty int, p_from date, p_to date, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare nm text; mn text; lbl text; miss int;
begin
  if not can_act_show(p_show) then raise exception 'Droits insuffisants : tu n''es pas assigné à ce spectacle' using errcode = '42501'; end if;
  select s.name, m.name into nm, mn from show_demands d join shows s on s.id = d.show_id join models m on m.id = d.model_id where d.id = p_demand and d.show_id = p_show;
  if nm is null then raise exception 'Demande introuvable' using errcode = '22023'; end if;
  if p_kind not in ('pret', 'location') then raise exception 'Type inconnu' using errcode = '22023'; end if;
  if nullif(trim(p_provider), '') is null or length(trim(p_provider)) > 80 then raise exception 'Nom du prêteur / loueur obligatoire' using errcode = '22023'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 500 then raise exception 'Quantité invalide' using errcode = '22023'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Dates invalides : la reprise ne peut pas précéder la livraison' using errcode = '22023'; end if;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  insert into show_externals (show_id, demand_id, kind, provider, qty, delivery_date, return_date, note, added_by_label)
  values (p_show, p_demand, p_kind, trim(p_provider), p_qty, p_from, p_to, nullif(trim(p_note), ''), lbl);
  perform log_event('SPECTACLE', format('« %s » : %s × %s %s %s (%s → %s)', nm, p_qty, mn, case p_kind when 'pret' then 'prêtés par' else 'loués chez' end, trim(p_provider), to_char(p_from, 'DD/MM'), to_char(p_to, 'DD/MM')));
  perform reallocate_all();
  select coalesce(sum(missing), 0)::int into miss from show_demands where show_id = p_show;
  return jsonb_build_object('missing', miss);
end $$;

create or replace function delete_external(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e show_externals; nm text;
begin
  select * into e from show_externals where id = p_id;
  if not found then return; end if;
  if not can_act_show(e.show_id) then raise exception 'Droits insuffisants : tu n''es pas assigné à ce spectacle' using errcode = '42501'; end if;
  delete from show_externals where id = p_id;
  select name into nm from shows where id = e.show_id;
  perform log_event('SPECTACLE', format('« %s » : %s × %s (%s) retiré', nm, e.qty, case e.kind when 'pret' then 'prêt' else 'location' end, e.provider));
  perform reallocate_all();
end $$;

revoke all on function add_external(uuid,uuid,text,text,int,date,date,text) from public;
revoke all on function delete_external(uuid) from public;
grant execute on function add_external(uuid,uuid,text,text,int,date,date,text) to authenticated;
grant execute on function delete_external(uuid) to authenticated;
revoke all on function reallocate_show(uuid) from public;
revoke all on function reallocate_all() from public;
revoke all on function item_blocked(int,uuid,date,date,boolean) from public;
revoke all on function set_demand(uuid,text,text,int) from public;
revoke all on function swap_show_item(uuid,int,int) from public;
revoke all on function release_show_item(uuid,int) from public;
grant execute on function set_demand(uuid,text,text,int) to authenticated;
grant execute on function swap_show_item(uuid,int,int) to authenticated;
grant execute on function release_show_item(uuid,int) to authenticated;

-- ---------- v1.12 : notifications push du mur ----------
-- Un abonnement = un appareil (navigateur / appli installée) d'une personne. Aucun accès direct à la table :
-- tout passe par les fonctions ci-dessous, et la fonction serveur « push-notify » lit avec la clé service.
create table if not exists push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null references auth.users on delete cascade,
  p256dh     text not null,
  auth_key   text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on push_subscriptions(user_id);
alter table push_subscriptions enable row level security;
alter table show_posts add column if not exists push_sent_at timestamptz;   -- un message n'est notifié qu'une seule fois

create or replace function save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_ua text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not has_role('technicien') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 or coalesce(length(p_p256dh), 0) = 0 or coalesce(length(p_auth), 0) = 0 then
    raise exception 'Abonnement invalide' using errcode = '22023';
  end if;
  -- sur un téléphone partagé, l'abonnement passe à la personne connectée
  insert into push_subscriptions (endpoint, user_id, p256dh, auth_key, user_agent)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth, left(p_ua, 200))
  on conflict (endpoint) do update set user_id = auth.uid(), p256dh = excluded.p256dh, auth_key = excluded.auth_key, user_agent = excluded.user_agent;
end $$;

create or replace function delete_push_subscription(p_endpoint text) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end $$;

-- Qui prévenir pour un message ? (auteur exclu, comptes actifs, un envoi par appareil)
--   message d'un spectacle : tous les régisseurs généraux et administrateurs, et les personnes concernées (régisseurs assignés, créateur du spectacle, personnes qui ont déjà écrit
--                            sur son mur, quel que soit leur rôle) + les personnes citées (@) ;
--   annonce admin / info générale : silencieuses, sauf pour les personnes citées.
-- « @all » prévient tous les comptes actifs, mais seulement s'il est écrit par un régisseur général ou un administrateur.
drop function if exists push_targets(uuid);
create or replace function push_targets(p_post uuid)
returns table(user_id uuid, endpoint text, p256dh text, auth_key text, mentioned boolean, everyone boolean, kind text, show_id uuid, show_name text, author_label text, body text)
language sql stable security definer set search_path = public as $$
  with p as (select * from show_posts where id = p_post),
  ment as (
    select distinct case when m[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then m[1]::uuid end as uid
      from p, regexp_matches(p.body, '@\[[^\]]+\]\(u:([0-9a-f-]{36})\)', 'g') as m
  ),
  all_ok as (
    select p.id from p join profiles a on a.id = p.author_id and a.active and a.role in ('regisseur_general', 'admin')
     where p.body ~* '(^|[^[:alnum:]_@])@all([^[:alnum:]_]|$)'
  ),
  src as (   -- m = cité, a = @all, c = concerné par le spectacle
    select ment.uid, 'm' as t from ment where ment.uid is not null
    union all select pr.id, 'a' from profiles pr, all_ok where pr.active
    union all select pr.id, 'c' from profiles pr, p where p.kind = 'show' and pr.active and pr.role in ('regisseur_general', 'admin')
    union all select r.user_id, 'c' from show_regisseurs r, p where p.kind = 'show' and r.show_id = p.show_id
    union all select sh.created_by, 'c' from shows sh, p where p.kind = 'show' and sh.id = p.show_id and sh.created_by is not null
    union all select sp.author_id, 'c' from show_posts sp, p where p.kind = 'show' and sp.show_id = p.show_id and sp.author_id is not null
  ),
  who as (
    select uid, bool_or(t = 'm') as mentioned, bool_or(t = 'a') and not bool_or(t = 'm') as everyone from src group by uid
  )
  select s.user_id, s.endpoint, s.p256dh, s.auth_key, who.mentioned, who.everyone,
         p.kind, p.show_id, sh.name, p.author_label, p.body
    from p
    join who on who.uid is distinct from p.author_id
    join profiles pr on pr.id = who.uid and pr.active
    join push_subscriptions s on s.user_id = pr.id
    left join shows sh on sh.id = p.show_id;
$$;

revoke all on function save_push_subscription(text,text,text,text) from public;
revoke all on function delete_push_subscription(text) from public;
grant execute on function save_push_subscription(text,text,text,text) to authenticated;
grant execute on function delete_push_subscription(text) to authenticated;
revoke all on function push_targets(uuid) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function push_targets(uuid) to service_role;
  end if;
end $$;

-- ---------- v1.13 : changement d'e-mail par l'utilisateur ----------
-- L'e-mail est l'identifiant de connexion (auth.users) ; profiles.email en est une copie, tenue à jour ici une fois
-- le changement confirmé par le lien reçu par e-mail. Tout le reste (rôle, messages, abonnements…) suit l'identifiant du compte.
create or replace function sync_profile_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update profiles set email = new.email where id = new.id and email is distinct from new.email;
  insert into app_log (actor, actor_label, kind, message)
  values (new.id, (select coalesce(nullif(trim(first_name || ' ' || last_name), ''), new.email) from profiles where id = new.id),
          'COMPTE', format('e-mail modifié : %s → %s', old.email, new.email));
  return new;
end $$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email and new.email is not null) execute function sync_profile_email();

-- ---------- v1.19 : demandes d'inscription ----------
-- Une personne sans compte envoie une demande depuis l'écran de connexion. Elle passe par la fonction « push-notify »
-- (clé service_role) : l'appli n'a aucun droit direct sur cette table. Seuls les administrateurs la lisent et la traitent.
create table if not exists signup_requests (
  id          uuid primary key default gen_random_uuid(),
  first_name  text not null check (length(first_name) between 1 and 60),
  last_name   text not null check (length(last_name) between 1 and 60),
  email       text not null check (length(email) between 5 and 120),
  message     text not null default '' check (length(message) <= 500),
  status      text not null default 'pending' check (status in ('pending', 'invited', 'refused')),
  created_at  timestamptz not null default now(),
  handled_by  uuid references profiles(id) on delete set null,
  handled_at  timestamptz
);
-- une seule demande « en attente » par adresse e-mail
create unique index if not exists signup_requests_pending_email on signup_requests (lower(email)) where status = 'pending';
alter table signup_requests enable row level security;
revoke all on signup_requests from anon, authenticated;
grant select on signup_requests to authenticated;
drop policy if exists signup_requests_admin_read on signup_requests;
create policy signup_requests_admin_read on signup_requests for select using (has_role('admin'));

-- Création d'une demande (appelée uniquement par la fonction serveur). Renvoie l'id et si une notification doit partir.
-- Silencieuse (aucune nouvelle ligne) si l'adresse a déjà un compte ou une demande en attente : on ne révèle pas qui a un compte.
create or replace function create_signup_request(p_first text, p_last text, p_email text, p_message text)
returns table(id uuid, is_new boolean)
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(coalesce(p_email, ''))); nid uuid;
begin
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(e) > 120 then raise exception 'Adresse e-mail invalide'; end if;
  if length(trim(coalesce(p_first, ''))) = 0 or length(trim(coalesce(p_last, ''))) = 0 then raise exception 'Prénom et nom obligatoires'; end if;
  if (select count(*) from signup_requests where created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Trop de demandes en ce moment, réessaie plus tard';
  end if;
  if exists (select 1 from profiles where lower(email) = e) or exists (select 1 from signup_requests where lower(signup_requests.email) = e and status = 'pending') then
    return query select null::uuid, false; return;
  end if;
  insert into signup_requests (first_name, last_name, email, message)
  values (left(trim(p_first), 60), left(trim(p_last), 60), e, left(trim(coalesce(p_message, '')), 500)) returning signup_requests.id into nid;
  return query select nid, true;
end $$;
revoke all on function create_signup_request(text, text, text, text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function create_signup_request(text, text, text, text) to service_role;
  end if;
end $$;

-- Traitement par un administrateur : « invited » (après l'invitation) ou « refused ».
create or replace function resolve_signup_request(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare r signup_requests;
begin
  if not has_role('admin') then raise exception 'Réservé aux administrateurs'; end if;
  if p_status not in ('invited', 'refused') then raise exception 'Statut invalide'; end if;
  update signup_requests set status = p_status, handled_by = auth.uid(), handled_at = now()
   where signup_requests.id = p_id and status = 'pending' returning * into r;
  if r.id is null then raise exception 'Demande introuvable ou déjà traitée'; end if;
  perform log_event('COMPTE', format('demande d''inscription de %s %s (%s) : %s', r.first_name, r.last_name, r.email, case p_status when 'invited' then 'invitée' else 'refusée' end));
end $$;
revoke all on function resolve_signup_request(uuid, text) from public, anon;
grant execute on function resolve_signup_request(uuid, text) to authenticated;

-- ---------- v1.21 : personnes en ligne + connexions / départs au journal ----------
-- L'appli envoie un signe de vie (presence_ping) toutes les minutes tant qu'elle est ouverte et visible.
--   - « en ligne » = signe de vie reçu il y a moins de 2 min 30 ;
--   - une session se termine après 5 min sans signe de vie : « départ » écrit au journal à l'heure du dernier signe de vie ;
--   - le départ est détecté au prochain signe de vie de n'importe qui (aucune tâche planifiée nécessaire) ;
--   - une déconnexion volontaire (presence_leave) écrit le départ tout de suite.
create table if not exists presence (
  user_id   uuid primary key references profiles(id) on delete cascade,
  last_seen timestamptz not null default now(),
  is_open   boolean not null default false
);
alter table presence enable row level security;   -- aucune politique : tout passe par les fonctions ci-dessous
revoke all on presence from anon, authenticated;

create or replace function person_label(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) from profiles where id = p_id
$$;
revoke all on function person_label(uuid) from public, anon, authenticated;

create or replace function presence_ping() returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r presence;
begin
  if me is null or not has_role('technicien') then return; end if;
  -- les autres sessions restées sans signe de vie plus de 5 min se terminent : départ daté du dernier signe de vie
  with gone as (
    update presence set is_open = false where is_open and last_seen < now() - interval '5 minutes' and user_id <> me
    returning user_id, last_seen)
  insert into app_log (at, actor, actor_label, kind, message)
  select g.last_seen, g.user_id, person_label(g.user_id), 'CONNEXION', 'départ de l''application' from gone g;
  insert into presence (user_id, last_seen, is_open) values (me, now() - interval '1 day', false) on conflict do nothing;
  select * into r from presence where user_id = me for update;
  if r.is_open and r.last_seen >= now() - interval '5 minutes' then
    update presence set last_seen = now() where user_id = me;                     -- session en cours : simple signe de vie
  else
    if r.is_open then   -- l'ancienne session était terminée sans départ noté
      insert into app_log (at, actor, actor_label, kind, message) values (r.last_seen, me, person_label(me), 'CONNEXION', 'départ de l''application');
    end if;
    update presence set is_open = true, last_seen = now() where user_id = me;
    perform log_event('CONNEXION', 'connexion à l''application');
  end if;
end $$;
revoke all on function presence_ping() from public, anon;
grant execute on function presence_ping() to authenticated;

-- Déconnexion volontaire : départ écrit tout de suite.
create or replace function presence_leave() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  update presence set is_open = false, last_seen = now() where user_id = auth.uid() and is_open;
  if found then perform log_event('CONNEXION', 'départ de l''application (déconnexion)'); end if;
end $$;
revoke all on function presence_leave() from public, anon;
grant execute on function presence_leave() to authenticated;

-- Personnes en ligne (visibles par tous les comptes actifs).
create or replace function online_users() returns table(user_id uuid, label text)
language sql stable security definer set search_path = public as $$
  select pr.user_id, person_label(pr.user_id) from presence pr join profiles p on p.id = pr.user_id
   where has_role('technicien') and p.active and pr.is_open and pr.last_seen > now() - interval '150 seconds'
   order by 2
$$;
revoke all on function online_users() from public, anon;
grant execute on function online_users() to authenticated;

-- La connexion par mot de passe passe désormais par le même signe de vie (évite les doublons au journal).
create or replace function log_login() returns void language plpgsql security definer set search_path = public as $$
begin
  perform presence_ping();
end $$;
revoke all on function log_login() from public;
grant execute on function log_login() to authenticated;

-- ---------- v1.23 : feuille de patch / focus d'un spectacle ----------
-- Une ligne par projecteur affecté (créée à la première saisie) + des lignes « N/C » (sans ID, libres).
-- Les gélatines ne sont pas ici : elles restent dans show_gels (une seule source).
create table if not exists patch_lines (
  id               uuid primary key default gen_random_uuid(),
  show_id          uuid not null references shows(id) on delete cascade,
  item_id          integer references items(id) on delete set null,   -- null = N/C
  circuit          text not null default '' check (length(circuit) <= 30),
  dimmer           text not null default '' check (length(dimmer) <= 30),          -- grada
  curve            text[] not null default '{lineaire}',                            -- lineaire, onoff, autre, direct
  dmx              text not null default '' check (dmx = '' or dmx ~ '^[0-9]{1,3}-[0-9]{1,3}$'),   -- univers-adresse
  model_text       text not null default '' check (length(model_text) <= 80),      -- modèle d'une ligne N/C
  accessories      text[] not null default '{}',                                    -- iris, gobo, volets, autre
  position         text not null default '',
  focus            boolean not null default false,
  notes            text not null default '' check (length(notes) <= 500),
  updated_at       timestamptz not null default now(),
  updated_by_label text
);
alter table patch_lines add column if not exists model_id text references models(id) on delete set null;   -- ligne N/C : modèle choisi dans le catalogue (prépa)
alter table patch_lines add column if not exists lamp_id text references lamps(id) on delete set null;       -- ligne N/C d'un PAR : lampe voulue
alter table patch_lines add column if not exists gels jsonb not null default '[]'::jsonb;   -- gélatines d'une ligne N/C : [{ref, color}] (celles d'un projecteur affecté sont dans show_gels)
create unique index if not exists patch_lines_item_uniq on patch_lines (show_id, item_id) where item_id is not null;
create index if not exists patch_lines_show_idx on patch_lines (show_id);
alter table patch_lines enable row level security;
revoke all on patch_lines from anon, authenticated;
grant select on patch_lines to authenticated;
drop policy if exists patch_lines_select on patch_lines;
create policy patch_lines_select on patch_lines for select using (has_role('technicien'));

-- Modifie UN champ d'une ligne (la crée si besoin). Renvoie la ligne complète.
--   technicien : grada et courbe seulement (sur les projecteurs affectés) ;
--   régisseur assigné, régisseur général, admin : tous les champs.
create or replace function set_patch_field(p_show uuid, p_item int, p_line uuid, p_field text, p_value jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r patch_lines; lbl text; txt text; arr text[]; ok text[];
begin
  if not has_role('technicien') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  if p_field not in ('circuit', 'dimmer', 'curve', 'dmx', 'model_text', 'model_id', 'lamp_id', 'external_id', 'accessories', 'position', 'focus', 'notes') then raise exception 'Champ inconnu' using errcode = '22023'; end if;
  if p_field not in ('dimmer', 'curve') and not can_act_show(p_show) then raise exception 'Droits insuffisants : tu n''es pas assigné à ce spectacle' using errcode = '42501'; end if;
  -- ligne existante, ou création pour un projecteur affecté
  if p_line is not null then select * into r from patch_lines where id = p_line and show_id = p_show;
  elsif p_item is not null then select * into r from patch_lines where show_id = p_show and item_id = p_item; end if;
  if r.id is null then
    if p_item is null or not exists (select 1 from show_items where show_id = p_show and item_id = p_item) then raise exception 'Ligne introuvable' using errcode = '22023'; end if;
    insert into patch_lines (show_id, item_id) values (p_show, p_item) returning * into r;
  end if;
  if p_field = 'external_id' and r.item_id is not null then raise exception 'Une location ne se rattache qu''à une ligne sans projecteur' using errcode = '22023'; end if;
  if p_field in ('model_text', 'model_id', 'lamp_id') and r.item_id is not null then raise exception 'Le modèle d''un projecteur vient de sa fiche' using errcode = '22023'; end if;
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) into lbl from profiles where id = auth.uid();
  if p_field in ('circuit', 'dimmer', 'dmx', 'model_text', 'position', 'notes') then
    txt := trim(coalesce(p_value #>> '{}', ''));
    if p_field = 'dmx' then
      if txt <> '' then
        if txt !~ '^[0-9]{1,3}-[0-9]{1,3}$' or split_part(txt, '-', 2)::int not between 1 and 512 or split_part(txt, '-', 1)::int < 1 then raise exception 'Adresse DMX : format univers-adresse (ex. 1-120, adresse de 1 à 512)' using errcode = '22023'; end if;
        if not ('direct' = any (r.curve)) then raise exception 'Coche d''abord la courbe DIRECT pour saisir une adresse DMX' using errcode = '22023'; end if;
      end if;
    elsif p_field = 'position' and txt <> '' and txt not in ('P1','P2','P3','P4','P5','P6','P7','P8','P9','P10','mezza J','mezza C','allemande J','allemande C','passerelle J','passerelle C','corbeille','balcon','3e','sol','pont coupole','coupole','autre') then
      raise exception 'Position inconnue' using errcode = '22023';
    end if;
    execute format('update patch_lines set %I = $1, updated_at = now(), updated_by_label = $2 where id = $3', p_field) using txt, lbl, r.id;
    if p_field = 'model_text' and txt <> '' then update patch_lines set model_id = null, lamp_id = null where id = r.id; end if;   -- texte libre ou modèle du catalogue, pas les deux
  elsif p_field = 'external_id' then   -- rattache la ligne sans projecteur à une location / un prêt du spectacle (ou la détache)
    txt := nullif(trim(coalesce(p_value #>> '{}', '')), '');
    if txt is null then update patch_lines set external_id = null, updated_at = now(), updated_by_label = lbl where id = r.id;
    else
      if not exists (select 1 from show_externals where id = txt::uuid and show_id = p_show) then raise exception 'Location ou prêt inconnu pour ce spectacle' using errcode = '22023'; end if;
      -- la ligne prend le modèle (et la lampe d'un PAR) de la demande liée à la location
      update patch_lines set external_id = txt::uuid, model_text = '', updated_at = now(), updated_by_label = lbl,
             model_id = (select d.model_id from show_externals e join show_demands d on d.id = e.demand_id where e.id = txt::uuid),
             lamp_id = (select d.lamp_id from show_externals e join show_demands d on d.id = e.demand_id where e.id = txt::uuid) where id = r.id;
    end if;
  elsif p_field in ('model_id', 'lamp_id') then
    txt := nullif(trim(coalesce(p_value #>> '{}', '')), '');
    if p_field = 'model_id' then
      if txt is not null and not exists (select 1 from models where id = txt) then raise exception 'Modèle inconnu' using errcode = '22023'; end if;
      update patch_lines set model_id = txt, lamp_id = case when txt is not distinct from model_id then lamp_id end, model_text = case when txt is not null then '' else model_text end,
             updated_at = now(), updated_by_label = lbl where id = r.id;
    else
      if txt is not null then
        if not exists (select 1 from lamps where id = txt) then raise exception 'Lampe inconnue' using errcode = '22023'; end if;
        if r.model_id is null or not exists (select 1 from models m join item_types t on t.id = m.type_id where m.id = r.model_id and t.name ilike 'PAR%') then
          raise exception 'La lampe ne concerne que les PAR' using errcode = '22023'; end if;
      end if;
      update patch_lines set lamp_id = txt, updated_at = now(), updated_by_label = lbl where id = r.id;
    end if;
  elsif p_field in ('curve', 'accessories') then
    if jsonb_typeof(p_value) <> 'array' then raise exception 'Liste attendue' using errcode = '22023'; end if;
    select coalesce(array_agg(distinct v), '{}') into arr from jsonb_array_elements_text(p_value) v;
    ok := case p_field when 'curve' then array['lineaire','onoff','autre','direct'] else array['iris','gobo','volets','autre'] end;
    if not (arr <@ ok) then raise exception 'Choix inconnu' using errcode = '22023'; end if;
    if p_field = 'curve' and cardinality(arr) <> 1 then raise exception 'Une courbe ne peut avoir qu''un seul choix' using errcode = '22023'; end if;
    if p_field = 'curve' and not ('direct' = any (arr)) then   -- plus de DIRECT : l'adresse DMX n'a plus de sens
      update patch_lines set dmx = '' where id = r.id;
    end if;
    execute format('update patch_lines set %I = $1, updated_at = now(), updated_by_label = $2 where id = $3', p_field) using arr, lbl, r.id;
  else   -- focus
    update patch_lines set focus = coalesce((p_value #>> '{}')::boolean, false), updated_at = now(), updated_by_label = lbl where id = r.id;
  end if;
  select * into r from patch_lines where id = r.id;
  return to_jsonb(r);
end $$;
revoke all on function set_patch_field(uuid, int, uuid, text, jsonb) from public, anon;
grant execute on function set_patch_field(uuid, int, uuid, text, jsonb) to authenticated;

-- ---------- v1.24 : feuille de patch, cellule ID, gélatines, lignes ----------
-- Journal + libellé de l'utilisateur courant (petit utilitaire des fonctions ci-dessous).
create or replace function patch_label() returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) from profiles where id = auth.uid();
$$;

-- Modèle d'un projecteur affecté (et lampe voulue s'il s'agit d'un PAR), pour les lignes qui passent « sans projecteur ».
create or replace function patch_item_model(p_show uuid, p_item int) returns table(m_id text, l_id text)
language sql stable security definer set search_path = public as $$
  select i.model_id,
         case when exists (select 1 from models m join item_types t on t.id = m.type_id where m.id = i.model_id and t.name ilike 'PAR%')
              then coalesce((select si.lamp_id from show_items si where si.show_id = p_show and si.item_id = i.id), i.lamp_id) end
    from items i where i.id = p_item;
$$;

-- Reporte les gélatines d'une ligne N/C ([{ref, color}]) sur un projecteur affecté.
create or replace function patch_gels_to_item(p_show uuid, p_item int, p_gels jsonb, p_label text) returns void
language sql security definer set search_path = public as $$
  insert into show_gels (show_id, item_id, ref, color, added_by_label)
  select p_show, p_item, g ->> 'ref', g ->> 'color', p_label from jsonb_array_elements(coalesce(p_gels, '[]'::jsonb)) g
   where exists (select 1 from show_items where show_id = p_show and item_id = p_item);
$$;

-- Change le projecteur d'une ligne de la feuille. Les gélatines appartiennent à la ligne (au circuit) : elles suivent la ligne dans tous les cas
-- (choose, new, replace, noid : une ligne sans projecteur garde les siennes dans patch_lines.gels). La ligne est désignée par p_item (ligne d'un projecteur) ou p_line (ligne N/C).
--   choose  : prend un projecteur déjà affecté au spectacle (p_target) ; les deux lignes s'échangent leurs projecteurs.
--   noid    : la ligne devient « sans projecteur » (N/C) ; l'ancien reste affecté, sur une ligne vide.
--   new     : ajoute au spectacle un projecteur (p_target, lampe p_lamp pour un PAR) et le met sur la ligne ; l'ancien reste affecté, sur une ligne vide.
--   replace : remplace le projecteur de la ligne par un autre du stock (p_target) ; l'ancien est retiré du spectacle ; les gélatines suivent.
-- Réservé au régisseur du spectacle, au régisseur général et à l'admin.
create or replace function patch_set_item(p_show uuid, p_item int, p_line uuid, p_mode text, p_target int default null, p_lamp text default null)
returns void language plpgsql security definer set search_path = public as $$
declare s shows; cb patch_lines; tb patch_lines; lbl text; res jsonb; oldsi show_items; m1 text; m2 text; gj jsonb; pm text; pl text;
begin
  if not can_act_show(p_show) then raise exception 'Droits insuffisants : tu n''es pas assigné à ce spectacle' using errcode = '42501'; end if;
  if p_mode not in ('choose', 'noid', 'new', 'replace') then raise exception 'Action inconnue' using errcode = '22023'; end if;
  select * into s from shows where id = p_show;
  if not found then raise exception 'Spectacle introuvable' using errcode = '22023'; end if;
  lbl := patch_label();
  -- ligne courante
  if p_item is not null then
    if not exists (select 1 from show_items where show_id = p_show and item_id = p_item) then raise exception 'Ligne introuvable' using errcode = '22023'; end if;
    select * into cb from patch_lines where show_id = p_show and item_id = p_item;
  else
    select * into cb from patch_lines where id = p_line and show_id = p_show and item_id is null;
    if cb.id is null then raise exception 'Ligne introuvable' using errcode = '22023'; end if;
  end if;
  if p_mode = 'replace' and p_item is null then raise exception 'Il n''y a pas de projecteur à remplacer sur cette ligne' using errcode = '22023'; end if;

  if p_mode = 'noid' then
    if p_item is null then return; end if;
    -- les gélatines suivent la ligne : elles passent de la liste du projecteur à la ligne sans projecteur
    select coalesce(jsonb_agg(jsonb_build_object('ref', ref, 'color', color) order by ref), '[]'::jsonb) into gj from show_gels where show_id = p_show and item_id = p_item;
    delete from show_gels where show_id = p_show and item_id = p_item;
    select m_id, l_id into pm, pl from patch_item_model(p_show, p_item);   -- la ligne garde le modèle (et la lampe voulue) du projecteur qu'elle quitte
    if cb.id is null then insert into patch_lines (show_id, item_id, gels, model_id, lamp_id, updated_by_label) values (p_show, null, gj, pm, pl, lbl);
    else update patch_lines set item_id = null, model_text = '', gels = gj, model_id = pm, lamp_id = pl, external_id = null, updated_at = now(), updated_by_label = lbl where id = cb.id; end if;
    perform log_event('SPECTACLE', format('« %s » : patch, la ligne du projecteur %s devient « sans projecteur » (il reste affecté)', s.name, p_item));
    return;
  end if;

  if p_target is null or p_target = p_item then raise exception 'Choisis un projecteur' using errcode = '22023'; end if;
  if not exists (select 1 from items where id = p_target) then raise exception 'Projecteur % introuvable', p_target using errcode = '22023'; end if;

  if p_mode = 'choose' then
    if not exists (select 1 from show_items where show_id = p_show and item_id = p_target) then raise exception 'Le projecteur % n''est pas affecté à ce spectacle', p_target using errcode = '22023'; end if;
    select * into tb from patch_lines where show_id = p_show and item_id = p_target;
    if p_item is not null then
      if cb.id is not null and tb.id is not null then   -- échange complet : on passe par « sans projecteur » pour respecter l'unicité
        update patch_lines set item_id = null where id = cb.id;
        update patch_lines set item_id = p_item, updated_at = now(), updated_by_label = lbl where id = tb.id;
        update patch_lines set item_id = p_target, updated_at = now(), updated_by_label = lbl where id = cb.id;
      elsif cb.id is not null then update patch_lines set item_id = p_target, updated_at = now(), updated_by_label = lbl where id = cb.id;
      elsif tb.id is not null then update patch_lines set item_id = p_item, updated_at = now(), updated_by_label = lbl where id = tb.id;
      end if;
      -- les gélatines appartiennent à la ligne (au circuit) : elles restent en place, donc changent de projecteur
      update show_gels set item_id = case when item_id = p_item then p_target else p_item end where show_id = p_show and item_id in (p_item, p_target);
      perform log_event('SPECTACLE', format('« %s » : patch, projecteurs %s et %s échangés de ligne (gélatines et saisie restent sur la ligne)', s.name, p_item, p_target));
    else   -- ligne N/C qui prend un projecteur affecté ; sa ligne d'origine devient N/C
      select coalesce(jsonb_agg(jsonb_build_object('ref', ref, 'color', color) order by ref), '[]'::jsonb) into gj from show_gels where show_id = p_show and item_id = p_target;
      delete from show_gels where show_id = p_show and item_id = p_target;   -- les gélatines de l'ancienne ligne du projecteur passent à la ligne qui devient N/C
      select m_id, l_id into pm, pl from patch_item_model(p_show, p_target);
      if tb.id is not null then update patch_lines set item_id = null, model_text = '', gels = gj, model_id = pm, lamp_id = pl, external_id = null, updated_at = now(), updated_by_label = lbl where id = tb.id;
      elsif jsonb_array_length(gj) > 0 then insert into patch_lines (show_id, item_id, gels, model_id, lamp_id, updated_by_label) values (p_show, null, gj, pm, pl, lbl); end if;
      perform patch_gels_to_item(p_show, p_target, cb.gels, lbl);   -- celles de la ligne N/C passent au projecteur
      update patch_lines set item_id = p_target, model_text = '', model_id = null, lamp_id = null, external_id = null, gels = '[]', updated_at = now(), updated_by_label = lbl where id = cb.id;
      perform log_event('SPECTACLE', format('« %s » : patch, une ligne sans projecteur prend le projecteur %s', s.name, p_target));
    end if;
    return;
  end if;

  -- new / replace : le projecteur vient du stock
  if exists (select 1 from show_items where show_id = p_show and item_id = p_target) then raise exception 'Le projecteur % est déjà affecté à ce spectacle (choisis-le dans la liste)', p_target using errcode = '22023'; end if;
  if exists (select 1 from faults where item_id = p_target and resolved_at is null) then raise exception 'Le projecteur % est en panne', p_target using errcode = '22023'; end if;
  if p_mode = 'replace' then
    select * into oldsi from show_items where show_id = p_show and item_id = p_item;
    select model_id into m1 from items where id = p_item; select model_id into m2 from items where id = p_target;
  end if;
  res := assign_items(p_show, array[p_target], p_lamp);   -- mêmes vérifications que partout (dates, prêt / SAV, lampe d'un PAR)
  if jsonb_array_length(res -> 'skipped') > 0 then raise exception 'Projecteur % : %', p_target, res -> 'skipped' -> 0 ->> 'reason' using errcode = '22023'; end if;
  delete from patch_lines where show_id = p_show and item_id = p_target;   -- reste d'une ancienne affectation
  if p_mode = 'new' then
    if p_item is null then
      perform patch_gels_to_item(p_show, p_target, cb.gels, lbl);   -- les gélatines de la ligne passent au projecteur ajouté
      update patch_lines set item_id = p_target, model_text = '', model_id = null, lamp_id = null, external_id = null, gels = '[]', updated_at = now(), updated_by_label = lbl where id = cb.id;
    elsif cb.id is not null then update patch_lines set item_id = p_target, updated_at = now(), updated_by_label = lbl where id = cb.id; end if;
    if p_item is not null then update show_gels set item_id = p_target where show_id = p_show and item_id = p_item; end if;   -- les gélatines suivent la ligne
    perform log_event('SPECTACLE', format('« %s » : patch, projecteur %s ajouté au spectacle sur une ligne', s.name, p_target));
    perform demand_attach(p_show, p_target);   -- il apparaît aussi dans le matériel demandé
    perform reallocate_all();
  else
    if oldsi.demand_id is not null and m1 is not distinct from m2 then update show_items set demand_id = oldsi.demand_id, pinned = true where show_id = p_show and item_id = p_target;   -- même modèle : il prend la place dans la même demande
    else perform demand_detach(p_show, p_item); perform demand_attach(p_show, p_target); end if;   -- autre modèle : l'ancienne demande baisse de 1, la nouvelle monte de 1
    update show_gels set item_id = p_target where show_id = p_show and item_id = p_item;   -- les gélatines restent sur la ligne
    if cb.id is not null then update patch_lines set item_id = p_target, updated_at = now(), updated_by_label = lbl where id = cb.id; end if;
    delete from show_items where show_id = p_show and item_id = p_item;
    perform log_event('SPECTACLE', format('« %s » : patch, projecteur %s remplacé par %s', s.name, p_item, p_target));
    perform reallocate_all();
  end if;
end $$;
revoke all on function patch_set_item(uuid, int, uuid, text, int, text) from public, anon;
grant execute on function patch_set_item(uuid, int, uuid, text, int, text) to authenticated;

-- Ajoute une ligne vide « sans projecteur » (N/C) à la feuille.
create or replace function patch_add_line(p_show uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r patch_lines;
begin
  if not can_act_show(p_show) then raise exception 'Droits insuffisants : tu n''es pas assigné à ce spectacle' using errcode = '42501'; end if;
  if not exists (select 1 from shows where id = p_show) then raise exception 'Spectacle introuvable' using errcode = '22023'; end if;
  if (select count(*) from patch_lines where show_id = p_show and item_id is null) >= 200 then raise exception 'Trop de lignes sans projecteur (200 maximum)' using errcode = '22023'; end if;
  insert into patch_lines (show_id, item_id, updated_by_label) values (p_show, null, patch_label()) returning * into r;
  return to_jsonb(r);
end $$;
revoke all on function patch_add_line(uuid) from public, anon;
grant execute on function patch_add_line(uuid) to authenticated;

-- Supprime une ligne. Ligne d'un projecteur : on vide sa saisie ; avec p_remove, le projecteur est aussi retiré du spectacle
-- (la demande de matériel dont il vient baisse de 1). Ligne N/C : elle disparaît.
create or replace function patch_delete_line(p_show uuid, p_item int, p_line uuid, p_remove boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare oldsi show_items;
begin
  if not can_act_show(p_show) then raise exception 'Droits insuffisants : tu n''es pas assigné à ce spectacle' using errcode = '42501'; end if;
  if p_item is not null then
    select * into oldsi from show_items where show_id = p_show and item_id = p_item;
    if not found then raise exception 'Ligne introuvable' using errcode = '22023'; end if;
    delete from patch_lines where show_id = p_show and item_id = p_item;
    if p_remove then perform demand_detach(p_show, p_item); perform unassign_items(p_show, array[p_item]); end if;   -- la demande baisse de 1 avec lui
  else
    delete from patch_lines where id = p_line and show_id = p_show and item_id is null;
    if not found then raise exception 'Ligne introuvable' using errcode = '22023'; end if;
  end if;
end $$;
revoke all on function patch_delete_line(uuid, int, uuid, boolean) from public, anon;
grant execute on function patch_delete_line(uuid, int, uuid, boolean) to authenticated;

-- Gélatines depuis la feuille : ouvert dès le technicien (sur les projecteurs affectés au spectacle).
create or replace function patch_add_gel(p_show uuid, p_item int, p_ref text, p_color text) returns uuid
language plpgsql security definer set search_path = public as $$
declare nm text; gid uuid;
begin
  if not has_role('technicien') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  if not exists (select 1 from show_items where show_id = p_show and item_id = p_item) then raise exception 'Projecteur non affecté à ce spectacle' using errcode = '22023'; end if;
  if nullif(trim(p_ref), '') is null or length(trim(p_ref)) > 60 then raise exception 'Référence du gel obligatoire (60 caractères maximum)' using errcode = '22023'; end if;
  if not (p_color = any (gel_colors())) then raise exception 'Couleur de gel inconnue' using errcode = '22023'; end if;
  insert into show_gels (show_id, item_id, ref, color, added_by_label) values (p_show, p_item, trim(p_ref), p_color, patch_label()) returning id into gid;
  select name into nm from shows where id = p_show;
  perform log_event('SPECTACLE', format('« %s » : gel %s (%s) ajouté sur le projecteur %s (feuille de patch)', nm, trim(p_ref), p_color, p_item));
  return gid;
end $$;
revoke all on function patch_add_gel(uuid, int, text, text) from public, anon;
grant execute on function patch_add_gel(uuid, int, text, text) to authenticated;

create or replace function patch_delete_gel(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare g show_gels; nm text;
begin
  if not has_role('technicien') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  select * into g from show_gels where id = p_id;
  if not found then return; end if;
  delete from show_gels where id = p_id;
  select name into nm from shows where id = g.show_id;
  perform log_event('SPECTACLE', format('« %s » : gel %s retiré du projecteur %s (feuille de patch)', nm, g.ref, g.item_id));
end $$;
revoke all on function patch_delete_gel(uuid) from public, anon;
grant execute on function patch_delete_gel(uuid) to authenticated;

-- v1.24.3 : les positions « allemande » sont réduites à Jardin et Cour (anciennes valeurs 1 / 2 regroupées)
update patch_lines set position = 'allemande J' where position in ('allemande J1', 'allemande J2');
update patch_lines set position = 'allemande C' where position in ('allemande C1', 'allemande C2');

-- v1.26.1 : une courbe n'a qu'un seul choix (les anciennes saisies multiples gardent DIRECT, sinon Off/On, sinon Autre, sinon Linéaire)
update patch_lines set curve = case when 'direct' = any (curve) then '{direct}'::text[] when 'onoff' = any (curve) then '{onoff}'::text[]
                                    when 'autre' = any (curve) then '{autre}'::text[] else '{lineaire}'::text[] end
 where cardinality(curve) <> 1;

-- v1.26.2 : gélatines d'une ligne sans projecteur (ouvert dès le technicien)
create or replace function patch_add_line_gel(p_show uuid, p_line uuid, p_ref text, p_color text) returns void
language plpgsql security definer set search_path = public as $$
declare r patch_lines; nm text;
begin
  if not has_role('technicien') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  select * into r from patch_lines where id = p_line and show_id = p_show and item_id is null;
  if r.id is null then raise exception 'Ligne introuvable' using errcode = '22023'; end if;
  if nullif(trim(p_ref), '') is null or length(trim(p_ref)) > 60 then raise exception 'Référence du gel obligatoire (60 caractères maximum)' using errcode = '22023'; end if;
  if not (p_color = any (gel_colors())) then raise exception 'Couleur de gel inconnue' using errcode = '22023'; end if;
  if jsonb_array_length(r.gels) >= 20 then raise exception 'Trop de gélatines sur cette ligne (20 maximum)' using errcode = '22023'; end if;
  update patch_lines set gels = gels || jsonb_build_array(jsonb_build_object('ref', trim(p_ref), 'color', p_color)), updated_at = now(), updated_by_label = patch_label() where id = r.id;
  select name into nm from shows where id = p_show;
  perform log_event('SPECTACLE', format('« %s » : gel %s (%s) ajouté sur une ligne sans projecteur (feuille de patch)', nm, trim(p_ref), p_color));
end $$;
revoke all on function patch_add_line_gel(uuid, uuid, text, text) from public, anon;
grant execute on function patch_add_line_gel(uuid, uuid, text, text) to authenticated;

create or replace function patch_delete_line_gel(p_show uuid, p_line uuid, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare r patch_lines; nm text;
begin
  if not has_role('technicien') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  select * into r from patch_lines where id = p_line and show_id = p_show and item_id is null;
  if r.id is null then raise exception 'Ligne introuvable' using errcode = '22023'; end if;
  update patch_lines set gels = coalesce((select jsonb_agg(g) from jsonb_array_elements(gels) g where g ->> 'ref' <> p_ref), '[]'::jsonb), updated_at = now(), updated_by_label = patch_label() where id = r.id;
  select name into nm from shows where id = p_show;
  perform log_event('SPECTACLE', format('« %s » : gel %s retiré d''une ligne sans projecteur (feuille de patch)', nm, p_ref));
end $$;
revoke all on function patch_delete_line_gel(uuid, uuid, text) from public, anon;
grant execute on function patch_delete_line_gel(uuid, uuid, text) to authenticated;

-- v1.30 : mode prépa — ajouter un modèle au catalogue depuis la feuille de patch (régisseur général et admin)
create or replace function add_model(p_name text, p_type text default null) returns text
language plpgsql security definer set search_path = public as $$
declare nm text := trim(coalesce(p_name, '')); mid text;
begin
  if not has_role('regisseur_general') then raise exception 'Droits insuffisants' using errcode = '42501'; end if;
  if nm = '' or length(nm) > 60 then raise exception 'Nom du modèle obligatoire (60 caractères maximum)' using errcode = '22023'; end if;
  if exists (select 1 from models where lower(name) = lower(nm)) then raise exception 'Ce modèle existe déjà' using errcode = '22023'; end if;
  if p_type is not null and not exists (select 1 from item_types where id = p_type) then raise exception 'Type inconnu' using errcode = '22023'; end if;
  insert into models (name, type_id) values (nm, p_type) returning id into mid;
  return mid;
end $$;
revoke all on function add_model(text, text) from public, anon;
grant execute on function add_model(text, text) to authenticated;

-- v1.32.0 : lignes sans projecteur rattachées à une location / un prêt du spectacle (information : compteur « placées / quantité »)
alter table patch_lines add column if not exists external_id uuid references show_externals(id) on delete set null;

-- v1.34.0 : pastille bleue (projecteur stocké au 3e quand il ne joue pas) et interrupteur monté / démonté d'un spectacle
alter table items add column if not exists blue_dot boolean not null default false;
alter table shows add column if not exists mounted boolean not null default false;      -- « monté » forcé à la main
alter table shows add column if not exists mounted_at timestamptz;                      -- quand il a été forcé (sert à savoir si c'est avant ou après l'exploitation)

-- Met ou retire la pastille bleue d'un projecteur (régisseur général ou admin).
create or replace function set_blue_dot(p_item int, p_value boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v boolean := coalesce(p_value, false);
begin
  if not has_role('regisseur_general') then raise exception 'Seuls les régisseurs généraux et les administrateurs peuvent changer la pastille bleue' using errcode = '42501'; end if;
  if not exists (select 1 from items where id = p_item) then raise exception 'Projecteur introuvable' using errcode = '22023'; end if;
  update items set blue_dot = v where id = p_item and blue_dot is distinct from v;
  if found then perform log_event('PASTILLE', format('#%s : pastille bleue %s (stocké au 3e)', p_item, case when v then 'ajoutée' else 'retirée' end)); end if;
end $$;
revoke all on function set_blue_dot(int, boolean) from public, anon;
grant execute on function set_blue_dot(int, boolean) to authenticated;

-- Force un spectacle « monté » ou « démonté » (régisseur général ou admin). Pendant l'exploitation il est figé monté.
-- Après le dernier jour, il redevient démonté tout seul, sauf s'il a été forcé monté après cette date (voir src/position.ts).
create or replace function set_show_mounted(p_show uuid, p_value boolean) returns void
language plpgsql security definer set search_path = public as $$
declare s shows; v boolean := coalesce(p_value, false); today date := (now() at time zone 'Europe/Paris')::date;
begin
  if not has_role('regisseur_general') then raise exception 'Seuls les régisseurs généraux et les administrateurs peuvent changer cet interrupteur' using errcode = '42501'; end if;
  select * into s from shows where id = p_show;
  if not found then raise exception 'Spectacle introuvable' using errcode = '22023'; end if;
  if today between s.start_date and s.end_date then raise exception 'Spectacle en cours : il est toujours monté' using errcode = '22023'; end if;
  update shows set mounted = v, mounted_at = now() where id = p_show;
  perform log_event('MONTAGE', format('« %s » noté %s', s.name, case when v then 'monté' else 'démonté' end));
end $$;
revoke all on function set_show_mounted(uuid, boolean) from public, anon;
grant execute on function set_show_mounted(uuid, boolean) to authenticated;

-- v1.36.0 : un projecteur mis dans la feuille de patch apparaît aussi dans le matériel demandé.
-- Rattache un projecteur affecté « à la main » à la demande « modèle + lampe » de son spectacle : si la demande a un manque, il le comble ;
-- sinon la demande monte de 1 (créée si elle n'existe pas). Le projecteur y est épinglé (l'assignation automatique n'y touche plus).
create or replace function demand_attach(p_show uuid, p_item int) returns void
language plpgsql security definer set search_path = public as $$
declare si show_items; mid text; ispar boolean; lp text; d show_demands; nm text; mn text;
begin
  select * into si from show_items where show_id = p_show and item_id = p_item;
  if not found or si.demand_id is not null then return; end if;
  select i.model_id into mid from items i where i.id = p_item;
  select exists (select 1 from models m join item_types t on t.id = m.type_id where m.id = mid and t.name ilike 'PAR%') into ispar;
  lp := case when ispar then coalesce(si.lamp_id, (select lamp_id from items where id = p_item)) end;
  if ispar and lp is null then return; end if;   -- PAR sans lampe connue : il reste affecté à la main
  select * into d from show_demands where show_id = p_show and model_id = mid and coalesce(lamp_id, '') = coalesce(lp, '');
  if not found then
    insert into show_demands (show_id, model_id, lamp_id, qty, added_by_label) values (p_show, mid, lp, 1, patch_label()) returning * into d;
  elsif d.missing <= 0 then update show_demands set qty = qty + 1 where id = d.id; end if;
  update show_items set demand_id = d.id, pinned = true, lamp_id = coalesce(lp, lamp_id) where show_id = p_show and item_id = p_item;
  if auth.uid() is not null then
    select name into nm from shows where id = p_show; select name into mn from models where id = mid;
    perform log_event('SPECTACLE', format('« %s » : le projecteur %s (%s) est compté dans le matériel demandé', nm, p_item, mn));
  end if;
end $$;
revoke all on function demand_attach(uuid, int) from public, anon, authenticated;

-- Inverse : un projecteur issu d'une demande quitte le spectacle, la demande baisse de 1 (jamais sous les prêts / locations déjà saisis ; supprimée à 0).
create or replace function demand_detach(p_show uuid, p_item int) returns void
language plpgsql security definer set search_path = public as $$
declare did uuid; ext int; nq int;
begin
  select demand_id into did from show_items where show_id = p_show and item_id = p_item;
  if did is null then return; end if;
  select coalesce(sum(qty), 0)::int into ext from show_externals where demand_id = did;
  update show_items set demand_id = null, pinned = false where show_id = p_show and item_id = p_item;   -- il n'appartient plus à la demande (il va être retiré ou remplacé)
  select greatest(qty - 1, ext) into nq from show_demands where id = did;
  if nq <= 0 then delete from show_demands where id = did;   -- plus rien demandé : la demande disparaît (la quantité 0 n'existe pas)
  else update show_demands set qty = nq where id = did; end if;
end $$;
revoke all on function demand_detach(uuid, int) from public, anon, authenticated;

-- Reprise de l'existant : les projecteurs déjà affectés à la main aux spectacles en cours ou à venir rejoignent le matériel demandé.
do $$ declare r record;
begin
  for r in select si.show_id, si.item_id from show_items si join shows s on s.id = si.show_id where si.demand_id is null and s.end_date >= current_date order by si.show_id, si.item_id loop
    perform demand_attach(r.show_id, r.item_id);
  end loop;
  perform reallocate_all();
end $$;
