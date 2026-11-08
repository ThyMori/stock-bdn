import QrScanner from 'qr-scanner';
import type { ViewFactory } from '../router';
import { go } from '../router';
import { can, canActShow, rpcCall, view } from '../store';
import { supabase } from '../supabase';
import { fullName, showColor, SHOW_COLORS } from '../types';
import { esc, parseScan, todayStr } from '../logic';
import { describe, norm } from '../ref';
import { openForm } from '../ui/dialog';
import { fmtDay } from './agenda';

const PAR_LAMPS = ['CP60', 'CP61', 'CP62', 'CP95'];
type Mode = 'view' | 'pick' | 'scan';

/** Fiche d'un spectacle : projecteurs assignés, ajout par lot (sélection manuelle ou scan QR). */
export const showView: ViewFactory = ([id]) => {
  let mode: Mode = 'view';
  const sel = new Set<number>();
  let type = '', q = '', lamp = '', msg = '';
  let stopScan: (() => void) | null = null;

  const isPar = (itemId: number): boolean => {
    const d = view(); const it = d.items.find((i) => i.id === itemId); if (!it) return false;
    return /^PAR/i.test(describe(d, it).type?.name ?? '');
  };
  const lampOptions = () => {
    const ls = view().lamps;
    const named = PAR_LAMPS.map((n) => ls.find((l) => l.name.toUpperCase().startsWith(n))).filter((l): l is NonNullable<typeof l> => !!l);
    const list = named.length ? named : ls.filter((l) => /^CP\d+/i.test(l.name));
    return list;
  };

  function paint(root: HTMLElement) {
    const d = view();
    const show = d.shows.find((s) => s.id === id);
    const el = root.querySelector('#dyn')!;
    if (!show) { el.innerHTML = `<div class="card empty">Spectacle introuvable.<br><a href="#/shows">Retour aux spectacles</a></div>`; return; }
    const today = todayStr();
    const regs = d.showRegisseurs.filter((r) => r.show_id === id).sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''));
    const mine = d.showItems.filter((s) => s.show_id === id).sort((a, b) => a.item_id - b.item_id);
    const canAssign = canActShow(id), canEdit = can('regisseur_general');
    const lampName = (lid: string | null) => d.lamps.find((l) => l.id === lid)?.name;

    const assigned = mine.map((s) => {
      const it = d.items.find((i) => i.id === s.item_id); const ds = it ? describe(d, it) : null;
      const want = lampName(s.lamp_id), cur = it ? lampName(it.lamp_id) : undefined;
      return `<div class="item"><a class="num" href="#/item/${s.item_id}">${s.item_id}</a>
        <div class="grow"><div class="t">${esc(ds?.model?.name)}</div><div class="s">${esc(ds?.type?.name)}${want ? ` · lampe requise : <b>${esc(want)}</b>` : ''}${want && cur && cur !== want ? ' <span class="tag late">changer la lampe</span>' : ''}</div></div>
        ${canAssign ? `<button class="btn" data-act="remove" data-v="${s.item_id}" aria-label="Retirer le projecteur ${s.item_id}">Retirer</button>` : ''}</div>`;
    }).join('');

    let picker = '';
    if (mode !== 'view' && canAssign) {
      const taken = new Set(mine.map((s) => s.item_id));
      const usedTypes = d.types.filter((t) => d.models.some((m) => m.type_id === t.id && d.items.some((i) => i.model_id === m.id)));
      const tokens = norm(q).split(/\s+/).filter(Boolean);
      const rows = d.items.filter((i) => !taken.has(i.id)).map((i) => ({ i, d: describe(d, i) }))
        .filter((r) => (!type || r.d.model?.type_id === type) && tokens.every((t) => norm(`${r.i.id} ${r.d.model?.name ?? ''} ${r.d.type?.name ?? ''}`).includes(t)));
      const needLamp = [...sel].some(isPar);
      const staged = [...sel].sort((a, b) => a - b);
      picker = `<div class="card stack"><h2>${mode === 'scan' ? 'Scanner un lot' : 'Ajouter des projecteurs'}</h2>
        <div class="chips"><button class="chip" data-act="mode" data-v="pick" aria-pressed="${mode === 'pick'}">Liste</button>
          <button class="chip" data-act="mode" data-v="scan" aria-pressed="${mode === 'scan'}">Scan QR</button></div>
        ${mode === 'scan' ? `<div class="viewport"><video playsinline muted></video></div>
          <form id="manual" class="row"><input name="n" inputmode="numeric" pattern="[0-9]*" placeholder="…ou saisir un n°" autocomplete="off"><button class="btn">Ajouter</button></form>
          <div class="sub" role="status">${esc(msg)}</div>
          <div class="sub">Lot : ${staged.length ? staged.map((n) => `<button class="chip" data-act="toggle" data-v="${n}" aria-pressed="true">${n} ✕</button>`).join(' ') : 'vide'}</div>`
        : `<input id="q" type="search" placeholder="N°, modèle…" autocomplete="off" value="${esc(q)}">
          <div class="chips"><button class="chip" data-act="type" data-v="" aria-pressed="${type === ''}">Tous types</button>
            ${usedTypes.map((t) => `<button class="chip" data-act="type" data-v="${t.id}" aria-pressed="${type === t.id}">${esc(t.name)}</button>`).join('')}</div>
          <div class="list pick-list">${rows.map(({ i, d: ds }) => `<label class="item"><input type="checkbox" data-act="toggle" data-v="${i.id}" ${sel.has(i.id) ? 'checked' : ''}>
            <div class="num">${i.id}</div><div class="grow"><div class="t">${esc(ds.model?.name)}</div><div class="s">${esc(ds.type?.name)}</div></div>
            <span class="badge ${i.eff ?? i.status}">${esc({ dispo: 'Disponible', utilise: 'Utilisé', sav: 'SAV', en_pret: 'En prêt' }[i.eff ?? i.status])}</span></label>`).join('') || '<div class="empty">Aucun projecteur</div>'}</div>`}
        ${needLamp ? `<label class="f">Lampe requise pour les PAR<select id="lamp"><option value="">— choisir —</option>${lampOptions().map((l) => `<option value="${l.id}" ${l.id === lamp ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>` : ''}
        <div id="aerr" class="sub warn" role="alert">${esc(mode === 'pick' ? msg : '')}</div>
        <div class="row"><button class="btn primary grow" data-act="assign" ${staged.length ? '' : 'disabled'}>Assigner ${staged.length || ''} projecteur${staged.length > 1 ? 's' : ''}</button>
          <button class="btn" data-act="mode" data-v="view">Fermer</button></div></div>`;
    }

    el.innerHTML = `<div class="card stack" style="border-left:10px solid ${showColor(show)}"><h1>${esc(show.name)}</h1>
        <div class="sub">du ${fmtDay(show.start_date)} au ${fmtDay(show.end_date)}${show.start_date <= today && show.end_date >= today ? ' · <span class="tag run">en cours</span>' : show.end_date < today ? ' · terminé' : ''}</div>
        ${show.note ? `<div>${esc(show.note)}</div>` : ''}
        ${canEdit ? `<div class="row"><button class="btn" data-act="edit">Modifier</button><button class="btn" data-act="delete">Supprimer</button></div>` : ''}
        <div id="serr" class="sub warn" role="alert"></div></div>
      <div class="card stack"><div class="row wrap"><h2 class="grow">Régisseurs (${regs.length})</h2>${canEdit ? '<button class="btn" data-act="reg-add">+ Assigner</button>' : ''}</div>
        ${regs.map((r) => `<div class="stack reg"><div class="t">${esc(r.label)}</div>${canEdit ? `<div class="row wrap"><button class="btn" data-act="reg-mail" data-v="${r.user_id}">Inviter par mail</button><button class="btn" data-act="reg-del" data-v="${r.user_id}" aria-label="Retirer ${esc(r.label)}">Retirer</button></div>` : ''}</div>`).join('') || '<div class="sub">Aucun régisseur assigné : seuls les régisseurs généraux peuvent agir sur ce spectacle.</div>'}
        ${!canAssign && can('regisseur') ? '<div class="sub warn">Tu n\'es pas assigné à ce spectacle : consultation seulement.</div>' : ''}</div>
      <div class="card"><div class="row"><h2 class="grow">Projecteurs (${mine.length})</h2>${canAssign && mode === 'view' ? '<button class="btn primary" data-act="mode" data-v="pick">+ Assigner</button>' : ''}</div>
        <div class="list">${assigned || '<div class="empty">Aucun projecteur assigné</div>'}</div></div>${picker}`;
    wire(root);
  }

  /** Active/arrête le scanner selon le mode. */
  function wire(root: HTMLElement) {
    stopScan?.(); stopScan = null;
    const video = root.querySelector('video');
    if (mode !== 'scan' || !video) return;
    let last = '', lastAt = 0;
    const add = (text: string) => {
      const n = parseScan(text);
      if (n === null) { msg = `QR non reconnu : « ${text.slice(0, 30)} »`; return; }
      if (!view().items.some((i) => i.id === n)) { msg = `Projecteur n° ${n} introuvable.`; return; }
      if (view().showItems.some((s) => s.show_id === id && s.item_id === n)) { msg = `N° ${n} déjà dans ce spectacle.`; return; }
      sel.add(n); msg = `N° ${n} ajouté au lot.`; navigator.vibrate?.(40);
      repaintKeepVideo(root);
    };
    (root as HTMLElement & { _add?: (t: string) => void })._add = add;
    const scanner = new QrScanner(video, (r) => {
      if (r.data === last && Date.now() - lastAt < 2500) return;
      last = r.data; lastAt = Date.now(); add(r.data);
    }, { returnDetailedScanResult: true, preferredCamera: 'environment', maxScansPerSecond: 8, highlightScanRegion: false });
    scanner.start().catch((e) => { msg = `Caméra indisponible (${String(e)}). Saisis les numéros à la main.`; repaintKeepVideo(root); });
    stopScan = () => { scanner.stop(); scanner.destroy(); };
  }
  /** Met à jour message / lot sans recréer la vidéo (sinon la caméra redémarre à chaque scan). */
  function repaintKeepVideo(root: HTMLElement) {
    const staged = [...sel].sort((a, b) => a - b);
    const status = root.querySelector('[role="status"]'); if (status) status.textContent = msg;
    const subs = root.querySelectorAll('.card .sub');
    const lot = [...subs].find((x) => x.textContent?.startsWith('Lot'));
    if (lot) lot.innerHTML = `Lot : ${staged.length ? staged.map((n) => `<button class="chip" data-act="toggle" data-v="${n}" aria-pressed="true">${n} ✕</button>`).join(' ') : 'vide'}`;
    const btn = root.querySelector<HTMLButtonElement>('[data-act="assign"]');
    if (btn) { btn.disabled = !staged.length; btn.textContent = `Assigner ${staged.length || ''} projecteur${staged.length > 1 ? 's' : ''}`; }
    const need = staged.some(isPar);
    if (need !== !!root.querySelector('#lamp')) { stopScan?.(); stopScan = null; paint(root); }
  }

  /** Ouvre le client mail avec une invitation prête à envoyer (aucun service d'envoi à configurer). */
  async function mailInvite(userId: string, err: (m: string) => void) {
    const show = view().shows.find((x) => x.id === id); if (!show) return;
    const { data: p, error } = await supabase.from('profiles').select('email,first_name,last_name').eq('id', userId).maybeSingle();
    if (error || !p) { err(error?.message ?? 'Compte introuvable'); return; }
    const link = `${location.origin}${location.pathname}#/show/${id}`;
    const body = `Bonjour ${p.first_name || ''},\n\nTu es assigné(e) comme régisseur sur « ${show.name} » (du ${fmtDay(show.start_date)} au ${fmtDay(show.end_date)}).\n\nTu peux y assigner les projecteurs ici : ${link}\n\nMerci !`;
    location.href = `mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent('Spectacle « ' + show.name + ' » : tu es assigné(e)')}&body=${encodeURIComponent(body)}`;
  }

  return {
    mount(root) {
      root.innerHTML = `<div class="page"><a href="#/shows">← Spectacles</a><div id="dyn" class="stack"></div></div>`;
      paint(root);
      root.addEventListener('input', (e) => {
        const t = e.target as HTMLInputElement;
        if (t.id === 'q') { q = t.value; const pos = t.selectionStart; paint(root); const n = root.querySelector<HTMLInputElement>('#q'); n?.focus(); n?.setSelectionRange(pos, pos); }
      });
      root.addEventListener('change', (e) => { const t = e.target as HTMLSelectElement; if (t.id === 'lamp') lamp = t.value; });
      root.addEventListener('submit', (e) => {
        if ((e.target as HTMLElement).id !== 'manual') return;
        e.preventDefault();
        const inp = (e.target as HTMLFormElement).elements.namedItem('n') as HTMLInputElement;
        (root as HTMLElement & { _add?: (t: string) => void })._add?.(inp.value); inp.value = '';
      });
      root.addEventListener('click', async (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]'); if (!el) return;
        const { act, v } = el.dataset;
        const err = (m: string) => { const x = root.querySelector('#serr'); if (x) x.textContent = m; };
        if (act === 'mode') { mode = v as Mode; msg = ''; if (mode === 'view') { sel.clear(); lamp = ''; } paint(root); }
        else if (act === 'type') { type = v ?? ''; paint(root); }
        else if (act === 'toggle') {
          const n = Number(v);
          if (el instanceof HTMLInputElement) { el.checked ? sel.add(n) : sel.delete(n); } else sel.delete(n);
          if (mode === 'scan') repaintKeepVideo(root); else paint(root);
        }
        else if (act === 'assign') {
          const items = [...sel];
          if (items.some(isPar) && !lamp) { msg = 'Choisis la lampe requise pour les PAR.'; const a = root.querySelector('#aerr'); if (a) a.textContent = msg; return; }
          const r = await rpcCall('assign_items', { p_show: id, p_items: items, p_lamp: items.some(isPar) ? lamp : null });
          if (r.error) { msg = r.error; const a = root.querySelector('#aerr'); if (a) a.textContent = msg; return; }
          const res = r.data as { added: number[]; skipped: { item: number; reason: string }[] } | null;
          const skipped = res?.skipped ?? [];
          sel.clear(); lamp = ''; mode = 'view'; paint(root);
          err(`${res?.added.length ?? 0} assigné(s).` + (skipped.length ? ' Refusés : ' + skipped.map((s) => `n° ${s.item} (${s.reason})`).join(' ; ') : ''));
        }
        else if (act === 'remove') {
          if (!window.confirm(`Retirer le projecteur n° ${v} de ce spectacle ?`)) return;
          const r = await rpcCall('unassign_items', { p_show: id, p_items: [Number(v)] });
          if (r.error) err(r.error);
        }
        else if (act === 'reg-add') {
          const { data: ps, error } = await supabase.from('profiles').select('id,email,role,first_name,last_name').in('role', ['regisseur', 'regisseur_general', 'admin']).eq('active', true);
          if (error) { err(error.message); return; }
          const have = new Set(view().showRegisseurs.filter((r) => r.show_id === id).map((r) => r.user_id));
          const opts = (ps ?? []).filter((p) => p.role === 'regisseur' && !have.has(p.id)).sort((a, b) => fullName(a).localeCompare(fullName(b))).map((p): [string, string] => [p.id, fullName(p)]);
          if (!opts.length) { err('Aucun régisseur à assigner (les régisseurs généraux et admins agissent déjà sur tous les spectacles).'); return; }
          const f = await openForm('Assigner un régisseur', [{ name: 'user', label: 'Régisseur', type: 'select', options: opts, required: true }], { submit: 'Assigner' });
          if (!f) return;
          const r = await rpcCall('assign_regisseur', { p_show: id, p_user: f.user });
          if (r.error) { err(r.error); return; }
          if (window.confirm('Régisseur assigné. Lui envoyer une invitation par mail ?')) await mailInvite(f.user, err);
        }
        else if (act === 'reg-mail') await mailInvite(v!, err);
        else if (act === 'reg-del') {
          if (!window.confirm('Retirer ce régisseur du spectacle ?')) return;
          const r = await rpcCall('unassign_regisseur', { p_show: id, p_user: v });
          if (r.error) err(r.error);
        }
        else if (act === 'edit') {
          const s = view().shows.find((x) => x.id === id); if (!s) return;
          const f = await openForm('Modifier le spectacle', [
            { name: 'name', label: 'Nom', required: true, value: s.name },
            { name: 'start', label: 'Début', type: 'date', required: true, value: s.start_date },
            { name: 'end', label: 'Fin', type: 'date', required: true, value: s.end_date },
            { name: 'color', label: 'Couleur', type: 'swatch', options: SHOW_COLORS, value: showColor(s), required: true },
            { name: 'note', label: 'Note', type: 'textarea', value: s.note ?? '' }
          ], { validate: (x) => (x.end < x.start ? 'La fin doit être après le début.' : null) });
          if (!f) return;
          const r = await rpcCall('edit_show', { p_id: id, p_name: f.name, p_start: f.start, p_end: f.end, p_note: f.note || null, p_color: f.color || null });
          if (r.error) err(r.error);
        }
        else if (act === 'delete') {
          if (!window.confirm('Supprimer ce spectacle et ses assignations ?')) return;
          const r = await rpcCall('delete_show', { p_id: id });
          if (r.error) err(r.error); else go('#/shows');
        }
      });
      return () => { stopScan?.(); stopScan = null; };
    },
    update(root) { if (mode !== 'scan') paint(root); }
  };
};
