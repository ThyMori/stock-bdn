import type { ViewFactory } from '../router';
import { can, pull, state, view } from '../store';
import { supabase } from '../supabase';
import { esc, fmtDate } from '../logic';
import { ROLE_LABEL, ROLE_RANK, ROLES, fullName } from '../types';
import type { AccountRow, Role } from '../types';

const opts = (list: { id: string; name?: string; label?: string }[], sel?: string | null, empty = '—') =>
  `<option value="">${empty}</option>` + list.map((o) => `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${esc(o.name ?? o.label)}</option>`).join('');
const num = (v: FormDataEntryValue | null) => (v === null || v === '' ? null : Number(v));
const str = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === '' ? null : String(v).trim());

/** Appelle la fonction serveur « admin-users » (la clé secrète ne quitte jamais Supabase). */
async function callAdmin(body: Record<string, unknown>): Promise<unknown> {
  if (!navigator.onLine) throw new Error('Cette action nécessite une connexion.');
  const { data, error } = await supabase.functions.invoke('admin-users', { body });
  if (error) {
    const res = (error as { context?: Response }).context;
    if (res?.status === 404) throw new Error('La fonction « admin-users » n\'est pas déployée sur Supabase (voir le README).');
    let msg = error.message;
    try { const j = await res?.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return data;
}

const ALL_TABS: [string, string][] = [['items', 'Projecteurs'], ['models', 'Modèles'], ['lamps', 'Lampes'], ['refs', 'Référentiels'], ['users', 'Utilisateurs']];

export const adminView: ViewFactory = ([want = 'items']) => ({
  mount(root) {
    // Le régisseur général n'a accès qu'aux projecteurs (ajout) et aux utilisateurs ; le reste est réservé aux admins.
    const isAdmin = can('admin');
    const TABS = ALL_TABS.filter(([k]) => isAdmin || k === 'items' || k === 'users');
    const section = TABS.some(([k]) => k === want) ? want : 'items';
    root.innerHTML = `<div class="page"><a href="#/more" class="sub">‹ Plus</a><h1>Administration</h1>
      <div class="chips">${TABS.map(([k, l]) => `<a class="chip" href="#/admin/${k}" aria-pressed="${k === section}">${l}</a>`).join('')}</div>
      <div id="msg" class="banner" hidden></div><div id="body" class="stack"></div></div>`;
    const body = root.querySelector<HTMLElement>('#body')!;
    const msg = root.querySelector<HTMLElement>('#msg')!;
    const say = (t: string, err = false) => { msg.hidden = !t; msg.textContent = t; msg.className = 'banner' + (err ? ' err' : ''); };
    const refresh = async () => { await pull(); void draw(); };
    // Écritures directes : nécessitent d'être en ligne (contrairement au suivi d'état / pannes).
    const run = async (p: PromiseLike<{ error: { message: string } | null }>, ok: string) => {
      if (!navigator.onLine) { say('Cette action nécessite une connexion.', true); return; }
      const { error } = await p;
      if (error) say('Erreur : ' + error.message, true); else { say(ok); await refresh(); }
    };

    async function draw() {
      const d = view();
      if (section === 'items') {
        body.innerHTML = `<form class="card stack" id="f"><h2>Ajouter des projecteurs</h2>
          <label class="f">Modèle<select name="m" required>${opts(d.models, null, 'Choisir…')}</select></label>
          <label class="f">Lampe<select name="l">${opts(d.lamps)}</select></label>
          <label class="f">Quantité<input name="n" type="number" min="1" max="100" value="1"></label>
          <button class="btn primary">Ajouter</button>
          <div class="sub">Les numéros sont attribués automatiquement à la suite. Imprime ensuite les étiquettes depuis « Étiquettes QR ».</div></form>`;
        body.querySelector('#f')!.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (!navigator.onLine) return say('Cette action nécessite une connexion.', true);
          const fd = new FormData(e.target as HTMLFormElement);
          const n = Math.min(100, Math.max(1, Number(fd.get('n')) || 1));
          const rows = Array.from({ length: n }, () => ({ model_id: fd.get('m'), lamp_id: fd.get('l') || null }));
          const { data, error } = await supabase.from('items').insert(rows).select('id');
          if (error) return say('Erreur : ' + error.message, true);
          const ids = (data ?? []).map((r) => r.id as number);
          say(`${ids.length} projecteur(s) ajouté(s) : n° ${Math.min(...ids)} à ${Math.max(...ids)}.`);
          await refresh();
        });
      }

      if (section === 'models') {
        const row = (m?: (typeof d.models)[number]) => `<form class="card stack" data-id="${m?.id ?? ''}">
          <label class="f">Nom<input name="name" required value="${esc(m?.name ?? '')}"></label>
          <div class="row"><label class="f grow">Famille<select name="family_id">${opts(d.families, m?.family_id)}</select></label>
            <label class="f grow">Type<select name="type_id">${opts(d.types, m?.type_id)}</select></label></div>
          <div class="row"><label class="f grow">Porte-filtre<select name="filter_size_id">${opts(d.filterSizes, m?.filter_size_id)}</select></label>
            <label class="f grow">Douille<select name="socket_id">${opts(d.sockets, m?.socket_id)}</select></label></div>
          <label class="f">Lien notice<input name="notice_url" type="url" value="${esc(m?.notice_url ?? '')}"></label>
          <div class="row"><button class="btn primary grow">${m ? 'Enregistrer' : 'Ajouter le modèle'}</button>${m ? '<button type="button" class="btn danger" data-del>Supprimer</button>' : ''}</div></form>`;
        body.innerHTML = `<details class="card"><summary>Nouveau modèle</summary><div style="margin-top:12px">${row()}</div></details>` +
          d.models.map((m) => `<details class="card"><summary>${esc(m.name)} <span class="muted">· ${d.items.filter((i) => i.model_id === m.id).length} unités</span></summary><div style="margin-top:12px">${row(m)}</div></details>`).join('');
        body.querySelectorAll('form').forEach((f) => {
          f.addEventListener('submit', (e) => {
            e.preventDefault();
            const fd = new FormData(f); const id = f.dataset.id;
            const rec = { name: str(fd.get('name')), family_id: str(fd.get('family_id')), type_id: str(fd.get('type_id')),
              filter_size_id: str(fd.get('filter_size_id')), socket_id: str(fd.get('socket_id')), notice_url: str(fd.get('notice_url')) };
            void run(id ? supabase.from('models').update(rec).eq('id', id) : supabase.from('models').insert(rec), 'Modèle enregistré.');
          });
          f.querySelector('[data-del]')?.addEventListener('click', () => {
            if (window.confirm('Supprimer ce modèle ? (impossible s\'il reste des projecteurs de ce modèle)')) void run(supabase.from('models').delete().eq('id', f.dataset.id!), 'Modèle supprimé.');
          });
        });
      }

      if (section === 'lamps') {
        const row = (l?: (typeof d.lamps)[number]) => `<form class="card stack" data-id="${l?.id ?? ''}">
          <label class="f">Nom<input name="name" required value="${esc(l?.name ?? '')}"></label>
          <div class="row"><label class="f grow">Puissance (W)<input name="power_w" type="number" value="${l?.power_w ?? ''}"></label>
            <label class="f grow">Température (K)<input name="temp_k" type="number" value="${l?.temp_k ?? ''}"></label></div>
          <label class="f">Douille<select name="socket_id">${opts(d.sockets, l?.socket_id)}</select></label>
          <div class="row"><button class="btn primary grow">${l ? 'Enregistrer' : 'Ajouter la lampe'}</button>${l ? '<button type="button" class="btn danger" data-del>Supprimer</button>' : ''}</div></form>`;
        body.innerHTML = `<details class="card"><summary>Nouvelle lampe</summary><div style="margin-top:12px">${row()}</div></details>` +
          d.lamps.map((l) => `<details class="card"><summary>${esc(l.name)} <span class="muted">· ${l.power_w ?? '?'} W</span></summary><div style="margin-top:12px">${row(l)}</div></details>`).join('');
        body.querySelectorAll('form').forEach((f) => {
          f.addEventListener('submit', (e) => {
            e.preventDefault();
            const fd = new FormData(f); const id = f.dataset.id;
            const rec = { name: str(fd.get('name')), power_w: num(fd.get('power_w')), temp_k: num(fd.get('temp_k')), socket_id: str(fd.get('socket_id')) };
            void run(id ? supabase.from('lamps').update(rec).eq('id', id) : supabase.from('lamps').insert(rec), 'Lampe enregistrée.');
          });
          f.querySelector('[data-del]')?.addEventListener('click', () => {
            if (window.confirm('Supprimer cette lampe ?')) void run(supabase.from('lamps').delete().eq('id', f.dataset.id!), 'Lampe supprimée.');
          });
        });
      }

      if (section === 'refs') {
        const simple = (title: string, table: string, list: { id: string; name: string }[]) => `
          <div class="card stack"><h2>${title}</h2>
            ${list.map((x) => `<div class="row"><span class="grow">${esc(x.name)}</span><button class="btn small danger" data-t="${table}" data-del="${x.id}">Supprimer</button></div>`).join('')}
            <form class="row" data-t="${table}"><input name="name" placeholder="Nouveau…" required><button class="btn small primary">Ajouter</button></form></div>`;
        body.innerHTML = simple('Familles', 'families', d.families) + simple('Types', 'item_types', d.types) + simple('Douilles', 'sockets', d.sockets) +
          `<div class="card stack"><h2>Porte-filtres</h2>
            ${d.filterSizes.map((x) => `<div class="row"><span class="grow">${esc(x.label)} <span class="muted">· LEE ${x.sheets_lee ?? '–'} · Rosco ${x.sheets_rosco ?? '–'}</span></span><button class="btn small danger" data-t="filter_sizes" data-del="${x.id}">Supprimer</button></div>`).join('')}
            <form class="stack" id="fs"><input name="label" placeholder="Taille (ex. 180 x 180)" required>
              <div class="row"><input name="lee" type="number" placeholder="Feuilles LEE"><input name="rosco" type="number" placeholder="Feuilles Rosco"></div>
              <button class="btn small primary">Ajouter</button></form></div>`;
        body.querySelectorAll<HTMLFormElement>('form[data-t]').forEach((f) => f.addEventListener('submit', (e) => {
          e.preventDefault();
          void run(supabase.from(f.dataset.t!).insert({ name: str(new FormData(f).get('name')) }), 'Ajouté.');
        }));
        body.querySelector('#fs')!.addEventListener('submit', (e) => {
          e.preventDefault(); const fd = new FormData(e.target as HTMLFormElement);
          void run(supabase.from('filter_sizes').insert({ label: str(fd.get('label')), sheets_lee: num(fd.get('lee')), sheets_rosco: num(fd.get('rosco')) }), 'Ajouté.');
        });
        body.querySelectorAll<HTMLElement>('[data-del]').forEach((b) => b.addEventListener('click', () => {
          if (window.confirm('Supprimer cet élément ?')) void run(supabase.from(b.dataset.t!).delete().eq('id', b.dataset.del!), 'Supprimé.');
        }));
      }

      if (section === 'users') {
        body.innerHTML = '<div class="sub">Chargement…</div>';
        let users: AccountRow[];
        try { users = ((await callAdmin({ action: 'list' })) as { users: AccountRow[] }).users; }
        catch (e) { body.innerHTML = ''; return say((e as Error).message, true); }
        const me = state.profile?.id;
        const redirect = new URL(import.meta.env.BASE_URL, location.origin).href;
        // Admin : tous les rôles, sur tous les comptes. Autres : uniquement en dessous de leur propre rang.
        const myRank = state.profile ? ROLE_RANK[state.profile.role] : 0;
        const canTouch = (r: Role) => isAdmin || ROLE_RANK[r] < myRank;
        const roleOpts = (sel?: Role) => ROLES.filter((r) => canTouch(r) || r === sel).map((r) => `<option value="${r}" ${r === sel ? 'selected' : ''} ${canTouch(r) ? '' : 'disabled'}>${ROLE_LABEL[r]}</option>`).join('');
        const statusOf = (u: AccountRow) => !u.active ? '<span class="warn">Accès révoqué</span>'
          : !u.confirmed ? '<span class="warn">Invitation envoyée, pas encore activée</span>'
          : `Actif · dernière connexion ${fmtDate(u.last_sign_in_at)}`;

        body.innerHTML = `<form class="card stack" id="inv"><h2>Inviter quelqu'un</h2>
            <label class="f">Prénom<input name="first_name" required autocomplete="off"></label>
            <label class="f">Nom<input name="last_name" required autocomplete="off"></label>
            <label class="f">Adresse e-mail<input name="email" type="email" required autocomplete="off"></label>
            <label class="f">Rôle<select name="role">${roleOpts('technicien')}</select></label>
            <button class="btn primary">Envoyer l'invitation</button>
            <div class="sub">La personne reçoit un e-mail, clique sur le lien et choisit son mot de passe.</div></form>` +
          '<div id="ulist" class="stack">' + users.map((u) => `<div class="card stack" data-id="${u.id}">
            <div class="row"><div class="grow"><div class="t">${esc(fullName(u))}${u.id === me ? ' <span class="muted">(toi)</span>' : ''}</div><div class="s">${u.first_name || u.last_name ? esc(u.email) + '<br>' : ''}${statusOf(u)}</div></div>
              <select data-role style="width:auto" ${u.id === me || !u.active || !canTouch(u.role) ? 'disabled' : ''}>${roleOpts(u.role)}</select></div>
            ${u.id !== me && !canTouch(u.role) ? '' : `<div class="row wrap">
              <button class="btn small" data-act="rename">Modifier le nom</button>
              ${u.id === me ? '' : `${u.active && !u.confirmed ? '<button class="btn small" data-act="resend">Renvoyer l\'invitation</button>' : ''}
              ${u.active ? '<button class="btn small danger" data-act="revoke">Révoquer l\'accès</button>' : '<button class="btn small primary" data-act="restore">Rétablir l\'accès</button>'}`}</div>`}
          </div>`).join('') + '</div>' +
          `<div class="sub">Révoquer un accès coupe immédiatement les droits et empêche toute nouvelle connexion, sans supprimer le compte ni l'historique. On peut le rétablir à tout moment.</div>`;

        body.querySelector('#inv')!.addEventListener('submit', async (e) => {
          e.preventDefault();
          const form = e.target as HTMLFormElement; const fd = new FormData(form);
          try {
            await callAdmin({ action: 'invite', email: fd.get('email'), first_name: fd.get('first_name'), last_name: fd.get('last_name'), role: fd.get('role'), redirect_to: redirect });
            say(`Invitation envoyée à ${fd.get('email')}.`); void draw();
          } catch (err) { say((err as Error).message, true); }
        });
        body.querySelectorAll<HTMLSelectElement>('select[data-role]').forEach((sel) => sel.addEventListener('change', async () => {
          const id = sel.closest<HTMLElement>('[data-id]')!.dataset.id!;
          try {
            await callAdmin({ action: 'set_role', id, role: sel.value });
            say('Rôle mis à jour (effectif à la prochaine ouverture de l\'appli pour cette personne).');
          } catch (err) { say((err as Error).message, true); void draw(); }
        }));
        body.querySelector('#ulist')!.addEventListener('click', async (e) => {
          const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
          const card = btn?.closest<HTMLElement>('[data-id]');
          if (!btn || !card) return;
          const id = card.dataset.id!; const act = btn.dataset.act;
          const email = card.querySelector('.t')?.textContent?.replace('(toi)', '').trim() ?? '';
          const u0 = users.find((x) => x.id === id)!;
          try {
            if (act === 'rename') {
              const first = window.prompt('Prénom', u0.first_name); if (first === null) return;
              const last = window.prompt('Nom', u0.last_name); if (last === null) return;
              await callAdmin({ action: 'set_name', id, first_name: first, last_name: last }); say('Nom mis à jour.');
            } else if (act === 'revoke') {
              if (!window.confirm(`Révoquer l'accès de ${email} ? Elle ne pourra plus se connecter ni voir les données. Son compte et l'historique sont conservés.`)) return;
              await callAdmin({ action: 'set_access', id, active: false }); say(`Accès de ${email} révoqué.`);
            } else if (act === 'restore') {
              await callAdmin({ action: 'set_access', id, active: true }); say(`Accès de ${email} rétabli.`);
            } else if (act === 'resend') {
              await callAdmin({ action: 'resend', id, redirect_to: redirect }); say(`Invitation renvoyée à ${email}.`);
            }
            void draw();
          } catch (err) { say((err as Error).message, true); }
        });
      }
    }
    void draw();
  }
});
