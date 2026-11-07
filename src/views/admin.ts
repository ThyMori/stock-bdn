import type { ViewFactory } from '../router';
import { pull, view } from '../store';
import { supabase } from '../supabase';
import { esc } from '../logic';
import { ROLE_LABEL } from '../types';
import type { Profile, Role } from '../types';

const opts = (list: { id: string; name?: string; label?: string }[], sel?: string | null, empty = '—') =>
  `<option value="">${empty}</option>` + list.map((o) => `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${esc(o.name ?? o.label)}</option>`).join('');
const num = (v: FormDataEntryValue | null) => (v === null || v === '' ? null : Number(v));
const str = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === '' ? null : String(v).trim());

const TABS: [string, string][] = [['items', 'Projecteurs'], ['models', 'Modèles'], ['lamps', 'Lampes'], ['refs', 'Référentiels'], ['users', 'Utilisateurs']];

export const adminView: ViewFactory = ([section = 'items']) => ({
  mount(root) {
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
        const { data, error } = await supabase.from('profiles').select('id,email,role').order('email');
        if (error) { body.innerHTML = ''; return say('Erreur : ' + error.message, true); }
        body.innerHTML = `<div class="sub">Pour inviter quelqu'un : Supabase › Authentication › Users › « Invite user ». Il apparaît ici avec le rôle Lecteur, à toi de le promouvoir.</div>` +
          (data as Profile[]).map((u) => `<div class="card row"><div class="grow">${esc(u.email)}</div>
            <select data-u="${u.id}" style="width:auto">${(['lecteur', 'technicien', 'admin'] as Role[]).map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select></div>`).join('');
        body.querySelectorAll<HTMLSelectElement>('select[data-u]').forEach((s) => s.addEventListener('change', async () => {
          const { error: e2 } = await supabase.from('profiles').update({ role: s.value }).eq('id', s.dataset.u!);
          say(e2 ? 'Erreur : ' + e2.message : 'Rôle mis à jour (effectif à la prochaine ouverture de l\'appli pour cette personne).', !!e2);
        }));
      }
    }
    void draw();
  }
});
