import QrScanner from 'qr-scanner';
import type { ViewFactory } from '../router';
import { go } from '../router';
import { can, canActShow, rpcCall, setLamp, state, view } from '../store';
import { supabase } from '../supabase';
import { fullName, gelCss, showColor, SHOW_COLORS } from '../types';
import { gelColorOf } from '../gels';
import { alertText, blockedReason, showAlerts } from '../alerts';
import { toast } from '../ui/toast';
import { esc, fmtDateTime, parseScan, todayStr, uuid } from '../logic';
import { fromEditable, mentionedIds, personColor, renderBody, toEditable } from '../wall';
import { knownPeople, loadPeople } from '../people';
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
  let composer: HTMLElement | null = null;
  let gref = '';
  const rsel = new Set<number>();

  /** Zone de saisie du mur : créée une seule fois pour ne jamais perdre un brouillon quand l'écran se rafraîchit. */
  const makeComposer = (): HTMLElement => {
    const c = document.createElement('div'); c.className = 'composer stack';
    c.innerHTML = `<textarea id="wallText" rows="3" maxlength="2000" placeholder="Écrire sur le mur : to-do, passation, horaires, dézonage fumée…" aria-label="Nouveau message"></textarea>
      <div class="row wrap"><button class="btn" data-act="wall-person" type="button">@ Citer une personne</button><button class="btn" data-act="wall-item" type="button"># Citer un projecteur</button>
        <button class="btn primary grow" data-act="wall-post" type="button">Publier</button></div><div id="wallErr" class="sub warn" role="alert"></div>`;
    return c;
  };

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
    const myId = state.profile?.id, admin = can('admin');
    const posts = d.showPosts.filter((p) => p.show_id === id).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const wall = `<div class="card stack mur"><div class="row"><h2 class="grow">Mur (${posts.length})</h2></div><div id="wallhost"></div>
      <div class="posts">${posts.map((p) => {
        const own = !!myId && p.author_id === myId, me = !!myId && mentionedIds(p.body).includes(myId);
        return `<article class="post${me ? ' tome' : ''}" style="--pc:${personColor(p.author_id)}"><header><b class="who">${esc(p.author_label ?? 'Compte supprimé')}</b>
          <time datetime="${esc(p.created_at)}">${esc(fmtDateTime(p.created_at))}</time>${p.edited_at ? ' <span class="muted">(modifié)</span>' : ''}${me ? ' <span class="tag late">te cite</span>' : ''}</header>
          <div class="body">${renderBody(p.body)}</div>
          ${own || admin ? `<div class="row wrap">${own ? `<button class="linkbtn" data-act="post-edit" data-v="${p.id}">Modifier</button>` : ''}<button class="linkbtn" data-act="post-del" data-v="${p.id}">Effacer</button></div>` : ''}</article>`;
      }).join('') || '<div class="sub">Aucun message pour l\'instant.</div>'}</div></div>`;
    const mine = d.showItems.filter((s) => s.show_id === id).sort((a, b) => a.item_id - b.item_id);
    const canAssign = canActShow(id), canEdit = can('regisseur_general');
    const lampName = (lid: string | null) => d.lamps.find((l) => l.id === lid)?.name;

    const gelChips = (itemId: number) => {
      const gs = d.showGels.filter((g) => g.show_id === id && g.item_id === itemId).sort((a, b) => a.ref.localeCompare(b.ref));
      return gs.length ? `<div class="gels">${gs.map((g) => `<span class="gel"><i style="background:${gelCss(g.color)}"></i>${esc(g.ref)}${canAssign ? `<button class="gx" data-act="gel-del" data-v="${g.id}" aria-label="Retirer le gel ${esc(g.ref)}">×</button>` : ''}</span>`).join('')}</div>` : '';
    };
    const sels = canAssign ? mine : [];
    for (const n of [...rsel]) if (!sels.some((s) => s.item_id === n)) rsel.delete(n);
    const modelOf = (n: number) => d.items.find((i) => i.id === n)?.model_id ?? '';
    const selModels = [...new Set(sels.map((s) => modelOf(s.item_id)))].map((m) => ({ id: m, name: d.models.find((x) => x.id === m)?.name ?? '?', ids: sels.filter((s) => modelOf(s.item_id) === m).map((s) => s.item_id) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    const origin = (s: (typeof mine)[number]) => (s.demand_id ? ` <span class="tag auto">${s.pinned ? 'choisi' : 'auto'}</span>` : '')
      + (s.problem ? ` <span class="tag late">indisponible : ${esc(s.problem)}</span>` : '');
    const assigned = mine.map((s) => {
      const it = d.items.find((i) => i.id === s.item_id); const ds = it ? describe(d, it) : null;
      const want = lampName(s.lamp_id), cur = it ? lampName(it.lamp_id) : undefined;
      return `<div class="item">${canAssign ? `<input type="checkbox" class="rsel" data-act="rtoggle" data-v="${s.item_id}" ${rsel.has(s.item_id) ? 'checked' : ''} aria-label="Sélectionner le projecteur ${s.item_id}">` : ''}<a class="num" href="#/item/${s.item_id}">${s.item_id}</a>
        <div class="grow"><div class="t">${esc(ds?.model?.name)}</div><div class="s">${esc(ds?.type?.name)}${origin(s)}${want ? ` · lampe requise : <b>${esc(want)}</b>` : ''}${gelChips(s.item_id)}${want && cur && cur !== want ? ` ${can('technicien') ? `<button class="tag late fixlamp" data-act="fix-lamp" data-v="${s.item_id}" data-l="${s.lamp_id}">passer en ${esc(want)}</button>` : '<span class="tag late">changer la lampe</span>'}` : ''}</div></div>
        ${canAssign ? `<div class="btns"><button class="btn" data-act="gel" data-v="${s.item_id}" aria-label="Ajouter un gel au projecteur ${s.item_id}">Gel</button>${s.demand_id
          ? `<button class="btn" data-act="swap" data-v="${s.item_id}" aria-label="Changer le projecteur ${s.item_id}">Changer</button>${s.pinned ? `<button class="btn" data-act="release" data-v="${s.item_id}" aria-label="Remettre le projecteur ${s.item_id} en automatique">Auto</button>` : ''}`
          : `<button class="btn" data-act="remove" data-v="${s.item_id}" aria-label="Retirer le projecteur ${s.item_id}">Retirer</button>`}</div>` : ''}</div>`;
    }).join('');

    const demands = d.showDemands.filter((x) => x.show_id === id).map((x) => ({ x, m: d.models.find((m) => m.id === x.model_id), l: lampName(x.lamp_id) }))
      .sort((a, b) => (a.m?.name ?? '').localeCompare(b.m?.name ?? '', 'fr', { numeric: true }) || (a.l ?? '').localeCompare(b.l ?? ''));
    const myAlert = showAlerts(d, '0000-00-00').find((a) => a.show.id === id);
    const alertCard = myAlert && show.end_date >= today ? `<div class="alert-card" role="alert">⚠ ALERTE MATÉRIEL : ${esc(alertText(myAlert))}<br>À réparer, louer ou emprunter.
      <ul>${myAlert.missing.map((m) => `<li>manque ${m.n} × ${esc(m.label)}</li>`).join('')}${myAlert.problems.map((p) => `<li>n° ${p.item} : ${esc(p.why)}</li>`).join('')}</ul></div>` : '';
    const demandCard = `<div class="card"><div class="row wrap"><h2 class="grow">Matériel demandé (${demands.reduce((n, r) => n + r.x.qty, 0)})</h2>${canAssign ? '<button class="btn primary" data-act="dem-add">+ Demande</button>' : ''}</div>
      <div class="sub">L'appli assigne seule les projecteurs disponibles (PAR déjà bien équipés en priorité) et se met à jour au fil des pannes, SAV et changements de lampe.</div>
      ${demands.map(({ x, m, l }) => `<div class="dem"><div class="grow"><div class="t">${esc(m?.name ?? '?')}${l ? ` · ${esc(l)}` : ''}</div><div class="s">${x.qty - x.missing} / ${x.qty} assigné${x.qty - x.missing > 1 ? 's' : ''}</div></div>
        ${x.missing > 0 ? `<span class="tag late">manque ${x.missing}</span>` : '<span class="tag ok">complet</span>'}
        ${canAssign ? `<button class="btn" data-act="dem-edit" data-v="${x.id}">Quantité</button><button class="btn" data-act="dem-del" data-v="${x.id}" aria-label="Supprimer la demande">Suppr.</button>` : ''}</div>`).join('') || '<div class="empty">Aucune demande : ajoute-en une, ou assigne des projecteurs à la main plus bas.</div>'}</div>`;

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
        <div class="gelpick"><label class="f">Gel (facultatif, appliqué à tout le lot)<input id="gref" placeholder="Réf., ex. L201 ou R80" value="${esc(gref)}" autocomplete="off"></label></div>
        ${needLamp ? `<label class="f">Lampe requise pour les PAR<select id="lamp"><option value="">— choisir —</option>${lampOptions().map((l) => `<option value="${l.id}" ${l.id === lamp ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>` : ''}
        <div id="aerr" class="sub warn" role="alert">${esc(mode === 'pick' ? msg : '')}</div>
        <div class="row"><button class="btn primary grow" data-act="assign" ${staged.length ? '' : 'disabled'}>Assigner ${staged.length || ''} projecteur${staged.length > 1 ? 's' : ''}</button>
          <button class="btn" data-act="mode" data-v="view">Fermer</button></div></div>`;
    }

    const listTop = root.querySelector('.pick-list')?.scrollTop ?? 0, pageTop = window.scrollY, focusId = (document.activeElement as HTMLElement | null)?.dataset?.v;
    el.innerHTML = `<div class="card stack" style="border-left:10px solid ${showColor(show)}"><h1>${esc(show.name)}</h1>
        <div class="sub">du ${fmtDay(show.start_date)} au ${fmtDay(show.end_date)}${show.start_date <= today && show.end_date >= today ? ' · <span class="tag run">en cours</span>' : show.end_date < today ? ' · terminé' : ''}</div>
        ${show.note ? `<div>${esc(show.note)}</div>` : ''}
        <div class="row wrap"><button class="btn" data-act="prep" ${mine.length ? '' : 'disabled'}><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h8M9 9h3"/></svg>Générer la liste de prépa</button>
          <button class="btn" data-act="teardown"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10M18 15l2 2 3-4"/></svg>Rapport de démontage</button></div>
        ${canEdit ? `<div class="row"><button class="btn" data-act="edit">Modifier</button><button class="btn" data-act="delete">Supprimer</button></div>` : ''}
        <div id="serr" class="sub warn" role="alert"></div></div>
      ${alertCard}
      ${wall}
      <div class="card stack"><div class="row wrap"><h2 class="grow">Régisseurs (${regs.length})</h2>${canEdit ? '<button class="btn" data-act="reg-add">+ Assigner</button>' : ''}</div>
        ${regs.map((r) => `<div class="stack reg"><div class="t">${esc(r.label)}</div>${canEdit ? `<div class="row wrap"><button class="btn" data-act="reg-mail" data-v="${r.user_id}">Inviter par mail</button><button class="btn" data-act="reg-del" data-v="${r.user_id}" aria-label="Retirer ${esc(r.label)}">Retirer</button></div>` : ''}</div>`).join('') || '<div class="sub">Aucun régisseur assigné : seuls les régisseurs généraux peuvent agir sur ce spectacle.</div>'}
        ${!canAssign && can('regisseur') ? '<div class="sub warn">Tu n\'es pas assigné à ce spectacle : consultation seulement.</div>' : ''}</div>
      ${demandCard}
      <div class="card"><div class="row"><h2 class="grow">Projecteurs (${mine.length})</h2>${canAssign && mode === 'view' ? '<button class="btn" data-act="mode" data-v="pick">+ Choisir à la main</button>' : ''}</div>
        ${sels.length > 1 || rsel.size ? `<div class="selbar"><button class="btn" data-act="rall">${rsel.size === sels.length ? 'Tout décocher' : 'Tout cocher'}</button>
          ${selModels.length > 1 ? selModels.map((m) => `<button class="chip" data-act="rmodel" data-v="${esc(m.id)}" aria-pressed="${m.ids.every((n) => rsel.has(n))}">${esc(m.name)} (${m.ids.length})</button>`).join('') : ''}
          ${rsel.size ? `<button class="btn primary" data-act="gel-sel">Gel sur la sélection (${rsel.size})</button><button class="btn" data-act="remove-sel">Retirer la sélection (${rsel.size})</button>` : ''}</div>` : ''}
        <div class="list">${assigned || '<div class="empty">Aucun projecteur assigné</div>'}</div></div>${picker}`;
    if (composer) root.querySelector('#wallhost')?.replaceChildren(composer);
    const pl = root.querySelector('.pick-list'); if (pl) pl.scrollTop = listTop;
    window.scrollTo(0, pageTop);
    if (focusId) root.querySelector<HTMLElement>(`input[data-v="${focusId}"]`)?.focus({ preventScroll: true });
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

  /** Livre le PDF : téléchargement direct sur ordinateur ; sur téléphone, fenêtre avec partage / téléchargement / ouverture (les téléchargements programmés y sont bloqués). */
  async function deliverPdf(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const file = new File([blob], filename, { type: 'application/pdf' });
    const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (!touch && !canShare) {
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000); return;
    }
    const dlg = document.createElement('dialog'); dlg.className = 'dlg';
    dlg.innerHTML = `<form method="dialog" class="stack"><h2>Liste de prépa prête</h2><div class="sub">${esc(filename)} · ${Math.max(1, Math.round(blob.size / 1024))} Ko</div>
      ${canShare ? '<button type="button" class="btn primary" data-a="share">Partager / enregistrer</button>' : ''}
      <a class="btn${canShare ? '' : ' primary'}" href="${url}" download="${esc(filename)}">Télécharger</a>
      <a class="btn" href="${url}" target="_blank" rel="noopener">Ouvrir</a>
      <div class="sub warn" id="shErr" role="alert"></div>
      <button class="btn" value="cancel">Fermer</button></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('click', async (e) => {
      if (!(e.target as HTMLElement).closest('[data-a="share"]')) return;
      try { await navigator.share({ files: [file], title: filename }); } catch (er) {
        if ((er as DOMException).name !== 'AbortError') dlg.querySelector('#shErr')!.textContent = 'Partage impossible : utilise « Télécharger » ou « Ouvrir ».';
      }
    });
    dlg.addEventListener('close', () => { dlg.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); });
    dlg.showModal();
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
      composer = makeComposer();
      void loadPeople();
      paint(root);
      root.addEventListener('input', (e) => {
        const t = e.target as HTMLInputElement;
        if (t.id === 'gref') gref = t.value;
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
        const wallErr = (m: string) => { const x = root.querySelector('#wallErr'); if (x) x.textContent = m; };
        const insertAtCursor = (t: string) => {
          const ta = root.querySelector<HTMLTextAreaElement>('#wallText'); if (!ta) return;
          const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
          ta.value = ta.value.slice(0, a) + t + ta.value.slice(b); ta.focus(); ta.setSelectionRange(a + t.length, a + t.length);
        };
        const err = (m: string) => { const x = root.querySelector('#serr'); if (x) x.textContent = m; toast(m); };
        const sendDemand = async (model: string, lampId: string, qty: number) => {
          const r = await rpcCall('set_demand', { p_show: id, p_model: model, p_lamp: lampId || null, p_qty: qty });
          if (r.error) { err(r.error); return; }
          const miss = (r.data as { missing?: number } | null)?.missing ?? 0;
          err(miss > 0 ? `⚠ Impossible de tout fournir : il manque ${miss} projecteur${miss > 1 ? 's' : ''} (à réparer, louer ou emprunter).` : '');
        };
        if (act === 'mode') { mode = v as Mode; msg = ''; if (mode === 'view') { sel.clear(); lamp = ''; } paint(root); }
        else if (act === 'type') { type = v ?? ''; paint(root); }
        else if (act === 'toggle') {
          const n = Number(v);
          if (el instanceof HTMLInputElement) { el.checked ? sel.add(n) : sel.delete(n); } else sel.delete(n);
          repaintKeepVideo(root);   // mise à jour sur place : la liste ne bouge pas
        }
        else if (act === 'assign') {
          const items = [...sel];
          if (items.some(isPar) && !lamp) { msg = 'Choisis la lampe requise pour les PAR.'; const a = root.querySelector('#aerr'); if (a) a.textContent = msg; return; }
          const r = await rpcCall('assign_items', { p_show: id, p_items: items, p_lamp: items.some(isPar) ? lamp : null });
          if (r.error) { msg = r.error; const a = root.querySelector('#aerr'); if (a) a.textContent = msg; return; }
          const res = r.data as { added: number[]; skipped: { item: number; reason: string }[] } | null;
          const skipped = res?.skipped ?? [];
          let gelNote = '';
          if (gref.trim() && res?.added.length) {
            const g = await rpcCall('add_gels', { p_show: id, p_items: res.added, p_ref: gref.trim(), p_color: gelColorOf(gref) });
            gelNote = g.error ? ` Gel non ajouté : ${g.error}` : ` Gel ${gref.trim()} ajouté.`;
          }
          sel.clear(); lamp = ''; gref = ''; mode = 'view'; paint(root);
          err(`${res?.added.length ?? 0} assigné(s).` + gelNote + (skipped.length ? ' Refusés : ' + skipped.map((s) => `n° ${s.item} (${s.reason})`).join(' ; ') : ''));
        }
        else if (act === 'gel') {
          const used = [...new Set(view().showGels.filter((g) => g.show_id === id).map((g) => g.ref))].sort();
          const f = await openForm(`Gel sur le projecteur ${v}`, [
            { name: 'ref', label: 'Référence du gel', required: true, hint: used.length ? `Déjà utilisés ici : ${used.join(', ')}` : 'Ex. L201 (Lee), R80 ou #80 (Rosco)' }
          ], { submit: 'Ajouter le gel' });
          if (!f) return;
          const r = await rpcCall('add_gels', { p_show: id, p_items: [Number(v)], p_ref: f.ref.trim(), p_color: gelColorOf(f.ref) });
          if (r.error) err(r.error);
        }
        else if (act === 'dem-add') {
          const dd = view();
          const tname = (m: { type_id: string | null }) => dd.types.find((t) => t.id === m.type_id)?.name ?? '';
          const stock = (mid: string) => dd.items.filter((i) => i.model_id === mid).length;
          const models = [...dd.models]
            .sort((a, b) => tname(a).localeCompare(tname(b), 'fr') || a.name.localeCompare(b.name, 'fr', { numeric: true }));
          if (!models.length) { err('Aucun modèle dans le catalogue.'); return; }
          const parModel = (mid: string) => /^PAR/i.test(tname(dd.models.find((m) => m.id === mid) ?? { type_id: null }));
          const f = await openForm('Demander du matériel', [
            { name: 'model', label: 'Modèle', type: 'select', required: true, options: models.map((m): [string, string] => [m.id, `${tname(m) ? tname(m) + ' · ' : ''}${m.name}${stock(m.id) ? '' : ' (0 en stock : à louer / emprunter)'}`]) },
            { name: 'lamp', label: 'Lampe (obligatoire pour un PAR)', type: 'select', options: [['', '—'], ...lampOptions().map((l): [string, string] => [l.id, l.name])] },
            { name: 'qty', label: 'Quantité', type: 'number', min: '1', max: '500', required: true, value: '1' }
          ], { submit: 'Demander', validate: (v) => !/^\d+$/.test(v.qty.trim()) || Number(v.qty) < 1 || Number(v.qty) > 500 ? 'Quantité : un nombre entre 1 et 500.' : parModel(v.model) && !v.lamp ? 'Choisis la lampe pour un PAR.' : null });
          if (!f) return;
          await sendDemand(f.model, parModel(f.model) ? f.lamp : '', Number(f.qty));
        }
        else if (act === 'dem-edit') {
          const x = view().showDemands.find((r) => r.id === v); if (!x) return;
          const f = await openForm('Quantité demandée', [{ name: 'qty', label: 'Quantité', type: 'number', min: '1', max: '500', required: true, value: String(x.qty) }],
            { submit: 'Enregistrer', validate: (w) => !/^\d+$/.test(w.qty.trim()) || Number(w.qty) < 1 || Number(w.qty) > 500 ? 'Quantité : un nombre entre 1 et 500.' : null });
          if (!f) return;
          await sendDemand(x.model_id, x.lamp_id ?? '', Number(f.qty));
        }
        else if (act === 'dem-del') {
          const x = view().showDemands.find((r) => r.id === v); if (!x) return;
          if (!window.confirm('Supprimer cette demande ? Les projecteurs assignés automatiquement seront libérés (ceux que tu as choisis restent).')) return;
          await sendDemand(x.model_id, x.lamp_id ?? '', 0);
        }
        else if (act === 'swap') {
          const dd = view(); const row = dd.showItems.find((r) => r.show_id === id && r.item_id === Number(v)); const it = dd.items.find((i) => i.id === Number(v)); if (!row || !it) return;
          const lampName = (lid: string | null) => dd.lamps.find((l) => l.id === lid)?.name;
          const taken = new Set(dd.showItems.filter((r) => r.show_id === id).map((r) => r.item_id));
          const cs = dd.shows.find((x) => x.id === id);
          const cands = dd.items.filter((i) => i.model_id === it.model_id && !taken.has(i.id) && (!cs || !blockedReason(dd, i.id, cs)))
            .sort((a, b) => Number(b.lamp_id === row.lamp_id) - Number(a.lamp_id === row.lamp_id) || a.id - b.id);
          if (!cands.length) { err('Aucun autre projecteur de ce modèle n\'est disponible pendant ce spectacle (déjà pris, SAV, prêt ou en panne).'); return; }
          const st = (i: (typeof cands)[number]) => ({ dispo: 'disponible', utilise: 'utilisé', sav: 'SAV', en_pret: 'en prêt' }[i.eff ?? i.status]);
          const f = await openForm(`Remplacer le projecteur ${v}`, [{ name: 'to', label: 'Par le projecteur', type: 'select', required: true,
            options: cands.map((i): [string, string] => [String(i.id), `n° ${i.id} · ${lampName(i.lamp_id) ?? 'sans lampe'} · ${st(i)}`]) }], { submit: 'Remplacer' });
          if (!f) return;
          const r = await rpcCall('swap_show_item', { p_show: id, p_old: Number(v), p_new: Number(f.to) });
          if (r.error) err(r.error);
        }
        else if (act === 'release') {
          const r = await rpcCall('release_show_item', { p_show: id, p_item: Number(v) });
          if (r.error) err(r.error);
        }
        else if (act === 'gel-del') {
          const r = await rpcCall('delete_gel', { p_id: v });
          if (r.error) err(r.error);
        }
        else if (act === 'rtoggle') { const n = Number(v); if (rsel.has(n)) rsel.delete(n); else rsel.add(n); paint(root); }
        else if (act === 'rall') {
          const all = view().showItems.filter((r) => r.show_id === id).map((r) => r.item_id);
          if (rsel.size === all.length) rsel.clear(); else all.forEach((n) => rsel.add(n));
          paint(root);
        }
        else if (act === 'rmodel') {
          const dd = view();
          const ids = dd.showItems.filter((r) => r.show_id === id && dd.items.find((i) => i.id === r.item_id)?.model_id === v).map((r) => r.item_id);
          if (ids.every((n) => rsel.has(n))) ids.forEach((n) => rsel.delete(n)); else ids.forEach((n) => rsel.add(n));
          paint(root);
        }
        else if (act === 'gel-sel') {
          const list = [...rsel].sort((a, b) => a - b); if (!list.length) return;
          const used = [...new Set(view().showGels.filter((g) => g.show_id === id).map((g) => g.ref))].sort();
          const f = await openForm(`Gel sur ${list.length} projecteur${list.length > 1 ? 's' : ''}`, [
            { name: 'ref', label: 'Référence du gel', required: true, hint: used.length ? `Déjà utilisés ici : ${used.join(', ')}` : 'Ex. L201 (Lee), R80 ou #80 (Rosco)' }], { submit: 'Ajouter le gel' });
          if (!f) return;
          const r = await rpcCall('add_gels', { p_show: id, p_items: list, p_ref: f.ref.trim(), p_color: gelColorOf(f.ref) });
          if (r.error) err(r.error); else { rsel.clear(); toast(`Gel ${f.ref.trim()} ajouté sur ${list.length} projecteur${list.length > 1 ? 's' : ''}.`, 'ok'); }
        }
        else if (act === 'remove-sel') {
          const rows = view().showItems.filter((r) => r.show_id === id && rsel.has(r.item_id));
          const list = rows.filter((r) => !r.demand_id).map((r) => r.item_id).sort((a, b) => a - b), auto = rows.length - list.length;
          if (!list.length) { err('Ces projecteurs viennent d\'une demande : change la quantité de la demande, ou utilise « Changer ».'); return; }
          if (!window.confirm(`Retirer ${list.length} projecteur${list.length > 1 ? 's' : ''} de ce spectacle (${list.join(', ')}) ?${auto ? `\n${auto} projecteur${auto > 1 ? 's' : ''} issu${auto > 1 ? 's' : ''} d'une demande ne seront pas retirés.` : ''}`)) return;
          const r = await rpcCall('unassign_items', { p_show: id, p_items: list });
          if (r.error) err(r.error); else { rsel.clear(); toast(`${list.length} projecteur${list.length > 1 ? 's' : ''} retiré${list.length > 1 ? 's' : ''}.`, 'ok'); }
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
        else if (act === 'prep') {
          try {
            const { buildPrepPdf } = await import('../prepPdf');
            const { blob, filename } = await buildPrepPdf(view(), id);
            await deliverPdf(blob, filename);
          } catch (e) { err('Impossible de générer le PDF : ' + String(e)); }
        }
        else if (act === 'teardown') {
          const d = view();
          const others = d.shows.filter((s) => s.id !== id).sort((a, b) => a.start_date.localeCompare(b.start_date) || a.name.localeCompare(b.name));
          if (!others.length) { err('Aucun autre spectacle : crée d’abord le prochain spectacle.'); return; }
          const cs = d.shows.find((s) => s.id === id)!;
          const def = others.find((s) => s.start_date >= cs.start_date) ?? others[others.length - 1];
          const f = await openForm('Rapport de démontage : prochain spectacle ?', [
            { name: 'next', label: 'Prochain spectacle', type: 'select', value: def.id, required: true,
              options: others.map((s): [string, string] => [s.id, `${s.name} (${fmtDay(s.start_date)} - ${fmtDay(s.end_date)})`]) }], { submit: 'Générer le rapport' });
          if (!f) return;
          try {
            const { buildTeardownPdf } = await import('../teardown');
            const { blob, filename } = await buildTeardownPdf(view(), id, f.next);
            await deliverPdf(blob, filename);
          } catch (e) { err('Impossible de générer le PDF : ' + String(e)); }
        }
        else if (act === 'wall-person') {
          const ppl = (await loadPeople()).filter((p) => p.id !== state.profile?.id);
          if (!ppl.length) { wallErr('Annuaire indisponible (connexion requise).'); return; }
          const f = await openForm('Citer une personne', [{ name: 'p', label: 'Personne', type: 'select', options: ppl.map((p): [string, string] => [p.id, p.label]), required: true }], { submit: 'Citer' });
          if (f) insertAtCursor('@' + (ppl.find((p) => p.id === f.p)?.label ?? '') + ' ');
        }
        else if (act === 'wall-item') {
          const assigned = view().showItems.filter((s) => s.show_id === id).map((s) => s.item_id).sort((a, b) => a - b);
          const f = await openForm('Citer un projecteur', [{ name: 'n', label: 'N° du projecteur', required: true, hint: assigned.length ? `Assignés à ce spectacle : ${assigned.join(', ')}` : undefined }],
            { submit: 'Citer', validate: (x) => (view().items.some((i) => String(i.id) === x.n.trim()) ? null : 'Projecteur inconnu.') });
          if (f) insertAtCursor('#' + f.n.trim() + ' ');
        }
        else if (act === 'wall-post') {
          const ta = root.querySelector<HTMLTextAreaElement>('#wallText'); if (!ta) return;
          const text = ta.value.trim(); if (!text) { wallErr('Écris un message avant de publier.'); return; }
          const ppl = knownPeople().length ? knownPeople() : await loadPeople();
          const r = await rpcCall('post_show_message', { p_id: uuid(), p_show: id, p_body: fromEditable(text, ppl) });
          if (r.error) wallErr(r.error); else { ta.value = ''; wallErr(''); }
        }
        else if (act === 'post-edit') {
          const p = view().showPosts.find((x) => x.id === v); if (!p) return;
          const f = await openForm('Modifier le message', [{ name: 'b', label: 'Message', type: 'textarea', required: true, value: toEditable(p.body) }]);
          if (!f) return;
          const r = await rpcCall('edit_show_message', { p_id: p.id, p_body: fromEditable(f.b, knownPeople().length ? knownPeople() : await loadPeople()) });
          if (r.error) wallErr(r.error);
        }
        else if (act === 'post-del') {
          if (!window.confirm('Effacer ce message ?')) return;
          const r = await rpcCall('delete_show_message', { p_id: v });
          if (r.error) wallErr(r.error);
        }
        else if (act === 'fix-lamp') setLamp(Number(v), el.dataset.l!);
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
