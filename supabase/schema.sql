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
