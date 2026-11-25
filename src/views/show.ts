import QrScanner from 'qr-scanner';
import type { ViewFactory } from '../router';
import { go } from '../router';
import { can, canActShow, rpcCall, setLamp, state, view } from '../store';
import { supabase } from '../supabase';
import { fullName, gelCss, showColor, SHOW_COLORS } from '../types';
import { gelColorOf, splitGelRefs } from '../gels';
import { POSITION_GROUPS } from '../patch';
import { isKeeping } from '../keepFault';
import { alertText, blockedReason, externalLabel, showAlerts } from '../alerts';
import { similarNames } from '../patchSuggest';
import { toast } from '../ui/toast';
import { esc, fmtDateTime, parseScan, sortShows, todayStr, uuid } from '../logic';
import { fromEditable, mentionedIds, personColor, renderBody, toEditable } from '../wall';
import { knownPeople, loadPeople } from '../people';
import { describe, norm } from '../ref';
import { openForm } from '../ui/dialog';
import { deliverPdf } from '../ui/deliverPdf';
import { ALL_OPT, notifyPost } from '../push';
import { fmtDay } from './agenda';
import { cashBeep } from '../ui/beep';
import { showMounted } from '../position';
import { ZONES } from '../zones';
import { openScanFlow } from '../ui/scanFlow';
import { slotsOf, slotsText, validateSlots } from '../slots';
import { openSlots } from '../ui/slotsDialog';
import { defaultPrevious, preAssignPlan, previousShows } from '../preAssign';
import { sparkle } from '../ui/sparkle';
import { previewPlan } from '../ui/preAssignDialog';

const PAR_LAMPS = ['CP60', 'CP61', 'CP62', 'CP95'];
type Mode = 'view' | 'pick' | 'scan';

/** Fiche d'un spectacle : projecteurs assignés, ajout par lot (sélection manuelle ou scan QR). */
export const showView: ViewFactory = ([id]) => {
  let mode: Mode = 'view';
  const sel = new Set<number>();
  let type = '', q = '', msg = '';
  let pos = '';                                  // position facultative donnée à tout le lot (feuille de patch)
  const lampBy = new Map<number, string>();      // lampe validée pour chaque PAR du lot (par défaut : celle déjà montée dessus)
  let stopScan: (() => void) | null = null;
  let composer: HTMLElement | null = null;
  const rsel = new Set<number>();
  let demFolded = true, itemsFolded = true, wallFolded = true, headFolded = true;   // « Matériel demandé » et « Projecteurs affectés » : repliés au départ (pas mémorisé)
  let modelFilter = '';   // modèle affiché dans la liste des projecteurs ('' = tous) : un filtre, pas une sélection

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

  /** PAR ajouté au lot : sa lampe montée est proposée par défaut (à valider) ; sans effet si elle n'est pas dans les lampes proposées. */
  const suggestLamp = (n: number): void => {
    const it = view().items.find((i) => i.id === n);
    if (it && isPar(n)) lampBy.set(n, it.lamp_id && lampOptions().some((l) => l.id === it.lamp_id) ? it.lamp_id : '');
  };
  /** Une ligne par PAR du lot : sa lampe, déjà choisie si elle est montée, à valider (obligatoire avant d'assigner). */
  const lampRows = (staged: number[]): string => staged.filter(isPar).map((n) => {
    const cur = lampBy.get(n) ?? '';
    return `<label class="f lamprow">PAR n° ${n} : lampe<select data-lamp="${n}"><option value="">— choisir —</option>${lampOptions().map((l) => `<option value="${l.id}" ${l.id === cur ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>`;
  }).join('');
  /** Position facultative du lot : liste déroulante (zones du théâtre). */
  const posSelect = (): string => `<label class="f">Position du lot (facultatif)<select id="lotpos"><option value="">— aucune —</option>${POSITION_GROUPS.map((g) => `<optgroup label="${esc(g.label)}">${g.items.map((i) => `<option value="${esc(i)}" ${i === pos ? 'selected' : ''}>${esc(i)}</option>`).join('')}</optgroup>`).join('')}</select></label>`;

  function paint(root: HTMLElement) {
    const d = view();
    const show = d.shows.find((s) => s.id === id);
    const el = root.querySelector('#dyn')!;
    if (!show) { el.innerHTML = `<div class="card empty">Spectacle introuvable.<br><a href="#/shows">Retour aux spectacles</a></div>`; return; }
    const today = todayStr();
    const regs = d.showRegisseurs.filter((r) => r.show_id === id).sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''));
    const myId = state.profile?.id, admin = can('admin');
    const posts = d.showPosts.filter((p) => p.show_id === id).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const wall = `<div class="card stack mur sec sec-wall"><div class="row wrap"><button class="fold grow" data-act="wall-fold" aria-expanded="${!wallFolded}" aria-label="${wallFolded ? 'Déplier' : 'Replier'} le mur"><span aria-hidden="true">${wallFolded ? '▸' : '▾'}</span> <h2>Mur (${posts.length})</h2></button></div>${wallFolded ? '' : '<div id="wallhost"></div>'}
      <div class="posts">${(wallFolded ? posts.slice(0, 1) : posts).map((p) => {   // replié : seulement le dernier message (le plus récent)
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
    const selModels = [...new Set(mine.map((s) => modelOf(s.item_id)))].map((m) => ({ id: m, name: d.models.find((x) => x.id === m)?.name ?? '?', ids: mine.filter((s) => modelOf(s.item_id) === m).map((s) => s.item_id) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    if (modelFilter && !selModels.some((m) => m.id === modelFilter)) modelFilter = '';   // plus aucun projecteur de ce modèle : on retire le filtre
    const origin = (s: (typeof mine)[number]) => (s.problem ? ` <span class="tag late">indisponible : ${esc(s.problem)}</span>` : '')
      + (d.faults.some((f) => f.item_id === s.item_id && isKeeping(f, today)) ? ` <span class="tag keep">panne connue : SAV après le spectacle</span>` : '');
    const itemRow = (s: (typeof mine)[number]) => {
      const it = d.items.find((i) => i.id === s.item_id); const ds = it ? describe(d, it) : null;
      const want = lampName(s.lamp_id), cur = it ? lampName(it.lamp_id) : undefined;
      return `<div class="item sitem">${canAssign ? `<input type="checkbox" class="rsel" data-act="rtoggle" data-v="${s.item_id}" ${rsel.has(s.item_id) ? 'checked' : ''} aria-label="Sélectionner le projecteur ${s.item_id}">` : ''}<a class="num" href="#/item/${s.item_id}">${s.item_id}</a>
        <div class="grow"><div class="s">${esc(ds?.model?.name)}${origin(s)}${want ? ` · lampe requise : <b>${esc(want)}</b>` : ''}${gelChips(s.item_id)}${want && cur && cur !== want ? ` ${can('technicien') ? `<button class="tag late fixlamp" data-act="fix-lamp" data-v="${s.item_id}" data-l="${s.lamp_id}">passer en ${esc(want)}</button>` : '<span class="tag late">changer la lampe</span>'}` : ''}</div></div>
        ${canAssign ? `<div class="btns"><button class="btn" data-act="gel" data-v="${s.item_id}" aria-label="Ajouter un gel au projecteur ${s.item_id}">Gel</button><button class="btn" data-act="remove" data-v="${s.item_id}" aria-label="Retirer le projecteur ${s.item_id}">Retirer</button></div>` : ''}</div>`;
    };

    // un groupe par modèle (affectés + modèles seulement demandés) : replié par défaut, un seul déployé à la fois ; « demandé » = somme des demandes du modèle
    const demOf = (m: string) => d.showDemands.filter((x) => x.show_id === id && x.model_id === m).reduce((n, x) => n + x.qty, 0);
    const grpIds = [...new Set([...selModels.map((m) => m.id), ...d.showDemands.filter((x) => x.show_id === id).map((x) => x.model_id)])];
    const groups = grpIds.map((m) => ({ id: m, name: d.models.find((x) => x.id === m)?.name ?? '?', rows: mine.filter((s) => modelOf(s.item_id) === m), dem: demOf(m) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    const assigned = groups.map((g) => {
      const open = modelFilter === g.id && g.rows.length > 0, bad = g.rows.filter((r) => r.problem).length;
      const gap = g.dem > g.rows.length ? ' short' : '';   // moins d'affectés que demandés : repère discret
      return `<div class="mgrp${open ? ' open' : ''}"><button class="mhead${gap}" ${g.rows.length ? `data-act="rmodel" data-v="${esc(g.id)}" aria-expanded="${open}"` : 'disabled'}><span aria-hidden="true">${g.rows.length ? (open ? '▾' : '▸') : '·'}</span> <span class="t grow">${esc(g.name)}</span><span class="s">Demandé ${g.dem} · Affectés ${g.rows.length}</span>${bad ? `<span class="tag late">${bad} indispo.</span>` : ''}</button>${open ? `${g.rows.length > 1 || rsel.size ? `<div class="selbar">${g.rows.length > 1 ? `<button class="btn" data-act="rall">${g.rows.every((r) => rsel.has(r.item_id)) ? 'Tout décocher' : 'Tout cocher'} (${g.rows.length})</button>` : ''}${rsel.size ? `<button class="btn primary" data-act="gel-sel">Gel sur la sélection (${rsel.size})</button><button class="btn" data-act="remove-sel">Retirer la sélection (${rsel.size})</button>` : ''}</div>` : ''}<div class="list">${g.rows.map(itemRow).join('')}</div>` : ''}</div>`;
    }).join('');

    const demands = d.showDemands.filter((x) => x.show_id === id).map((x) => ({ x, m: d.models.find((m) => m.id === x.model_id), l: lampName(x.lamp_id) }))
      .sort((a, b) => (a.m?.name ?? '').localeCompare(b.m?.name ?? '', 'fr', { numeric: true }) || (a.l ?? '').localeCompare(b.l ?? ''));
    // projecteurs affectés (utilisables) qui comptent pour cette demande : même modèle, et même lampe pour un PAR
    const own = (x: (typeof demands)[number]['x']) => d.showItems.filter((r) => r.show_id === id && !r.problem && d.items.find((i) => i.id === r.item_id)?.model_id === x.model_id && (!x.lamp_id || r.lamp_id === x.lamp_id)).length;
    const extQty = (demId: string) => d.showExternals.filter((e) => e.demand_id === demId).reduce((n, e) => n + e.qty, 0);
    const subQty = (demId: string) => d.showSubstitutions.filter((b) => b.demand_id === demId).reduce((n, b) => n + b.qty, 0);   // part couverte par d'autres modèles
    const myAlert = showAlerts(d, '0000-00-00').find((a) => a.show.id === id);
    const alertCard = myAlert && show.end_date >= today ? `<div class="alert-card" role="alert">⚠ ALERTE MATÉRIEL : ${esc(alertText(myAlert))}<br>À réparer, louer ou emprunter.
      <ul>${myAlert.missing.map((m) => `<li>manque ${m.n} × ${esc(m.label)}</li>`).join('')}${myAlert.problems.map((p) => `<li>n° ${p.item} : ${esc(p.why)}</li>`).join('')}</ul></div>` : '';
    const missingTotal = demands.reduce((n, r) => n + r.x.missing, 0);
    const demandCard = `<div class="card sec sec-dem"><div class="row wrap"><button class="fold grow" data-act="dem-fold" aria-expanded="${!demFolded}" aria-label="${demFolded ? 'Déplier' : 'Replier'} le matériel demandé"><span aria-hidden="true">${demFolded ? '▸' : '▾'}</span> <h2>Matériel demandé (${demands.reduce((n, r) => n + r.x.qty, 0)})</h2></button><span class="tag auto">objectif</span>${demFolded && missingTotal ? `<span class="tag late">manque ${missingTotal}</span>` : ''}${canAssign && !demFolded ? '<button class="btn primary" data-act="dem-add">+ Demande</button>' : ''}</div>
      ${demFolded ? '' : `<div class="sub">Objectifs de quantité (fiche technique, plan de feu) : l'appli les compare aux projecteurs disponibles aux dates du spectacle, en partageant le stock avec les autres spectacles. Les n° précis se choisissent dans « Projecteurs affectés ».</div>      ${demands.map(({ x, m, l }) => `<div class="dem"><div class="grow"><div class="t">${esc(m?.name ?? '?')}${l ? ` · ${esc(l)}` : ''}</div><div class="s">Demandé ${x.qty} · Affectés ${own(x)}${extQty(x.id) ? ` · ${extQty(x.id)} prêté${extQty(x.id) > 1 ? 's' : ''} / loué${extQty(x.id) > 1 ? 's' : ''}` : ''}${subQty(x.id) ? ` · ${subQty(x.id)} en substitution` : ''}${x.available != null ? ` · Disponibles ${Math.max(0, x.available)}` : ''}</div>${(() => { const sl = slotsOf(d, x.id), t = slotsText(sl, Object.fromEntries(ZONES)), bad = validateSlots(sl, x.qty); return t ? `<div class="s slot-line"><span class="tag zone">Répartition</span> ${esc(t)}${bad ? ` <span class="tag late">${esc(bad)}</span>` : ''}</div>` : ''; })()}</div>
        ${x.missing > 0 ? `<span class="tag late">manque ${x.missing}</span>` : '<span class="tag ok">complet</span>'}
        ${canAssign && x.missing > 0 ? `<button class="btn primary" data-act="ext-add" data-v="${x.id}">Gérer</button>` : ''}
        ${canAssign ? `<button class="btn" data-act="dgel-add" data-v="${x.id}" aria-label="Demander des gélatines pour cette demande">Gel</button><button class="btn" data-act="dem-edit" data-v="${x.id}">Quantité</button><button class="btn" data-act="dem-slots" data-v="${x.id}">Répartir</button><button class="btn" data-act="dem-del" data-v="${x.id}" aria-label="Supprimer la demande">Suppr.</button>` : ''}</div>
        ${(() => { const gs = d.showDemandGels.filter((g) => g.demand_id === x.id).sort((a, b) => a.ref.localeCompare(b.ref, 'fr', { numeric: true }));
          return gs.length ? `<div class="gels">${gs.map((g) => `<span class="gel"><i style="background:${gelCss(g.color)}"></i>${esc(g.ref)} × ${Math.min(g.qty, x.qty)}${canAssign ? `<button class="gx" data-act="dgel-del" data-v="${g.id}" aria-label="Retirer le gel ${esc(g.ref)} de la demande">×</button>` : ''}</span>`).join('')}</div>` : ''; })()}
        ${d.showSubstitutions.filter((b) => b.demand_id === x.id).map((b) => `<div class="extline"><span class="tag ext">substitution</span><div class="grow">${b.qty} × ${esc(d.models.find((mm) => mm.id === b.model_id)?.name ?? '?')} à la place de ${esc(m?.name ?? '?')}</div>${canAssign ? `<button class="btn" data-act="sub-del" data-v="${b.id}" aria-label="Retirer cette substitution">Suppr.</button>` : ''}</div>`).join('')}
        ${d.showExternals.filter((e) => e.demand_id === x.id).map((e) => `<div class="extline"><span class="tag ext">${e.kind === 'pret' ? 'prêt' : 'location'}</span><div class="grow">${esc(externalLabel(d, e))}<br><span class="muted">livraison ${esc(fmtDay(e.delivery_date))} · reprise ${esc(fmtDay(e.return_date))}</span></div>${canAssign ? `<button class="btn" data-act="ext-del" data-v="${e.id}" aria-label="Retirer ce prêt ou cette location">Suppr.</button>` : ''}</div>`).join('')}`).join('') || '<div class="empty">Aucune demande : ajoute-en une, ou assigne des projecteurs à la main plus haut.</div>'}`}</div>`;

    let picker = '';
    if (mode !== 'view' && canAssign) {
      const taken = new Set(mine.map((s) => s.item_id));
      const usedTypes = d.types.filter((t) => d.models.some((m) => m.type_id === t.id && d.items.some((i) => i.model_id === m.id)));
      const tokens = norm(q).split(/\s+/).filter(Boolean);
      const rows = d.items.filter((i) => !taken.has(i.id)).map((i) => ({ i, d: describe(d, i) }))
        .filter((r) => (!type || r.d.model?.type_id === type) && tokens.every((t) => norm(`${r.i.id} ${r.d.model?.name ?? ''} ${r.d.type?.name ?? ''}`).includes(t)));
      const staged = [...sel].sort((a, b) => a - b);
      picker = `<div class="card stack picker"><h2>${mode === 'scan' ? 'Scanner un lot' : 'Ajouter des projecteurs'}</h2>
        <div class="chips"><button class="chip" data-act="mode" data-v="pick" aria-pressed="${mode === 'pick'}">Liste</button>
          <button class="chip" data-act="mode" data-v="scan" aria-pressed="${mode === 'scan'}">Scan QR</button></div>
        ${mode === 'scan' ? `<div class="viewport"><video playsinline muted></video></div>
          ${posSelect()}
          <div class="sub" id="lot">Lot : ${staged.length ? staged.map((n) => `<button class="chip" data-act="toggle" data-v="${n}" aria-pressed="true">${n} ✕</button>`).join(' ') : 'vide'}</div>`
        : `<input id="q" type="search" placeholder="N°, modèle…" autocomplete="off" value="${esc(q)}">
          <div class="chips"><span class="sub">Filtre :</span><button class="chip" data-act="type" data-v="" aria-pressed="${type === ''}">Tous types</button>
            ${usedTypes.map((t) => `<button class="chip" data-act="type" data-v="${t.id}" aria-pressed="${type === t.id}">${esc(t.name)}</button>`).join('')}</div>
          <div class="list pick-list">${rows.map(({ i, d: ds }) => `<label class="item"><input type="checkbox" data-act="toggle" data-v="${i.id}" ${sel.has(i.id) ? 'checked' : ''}>
            <div class="num">${i.id}</div><div class="grow"><div class="t">${esc(ds.model?.name)}</div><div class="s">${esc(ds.type?.name)}</div></div>
            <span class="badge ${i.eff ?? i.status}">${esc({ dispo: 'Disponible', utilise: 'Utilisé', sav: 'SAV', en_pret: 'En prêt' }[i.eff ?? i.status])}</span></label>`).join('') || '<div class="empty">Aucun projecteur</div>'}</div>`}
        ${mode === 'pick' ? posSelect() : ''}
        <div id="lamprows" class="stack">${lampRows(staged)}</div>
        ${mode === 'scan' ? `<form id="manual" class="row"><input name="n" inputmode="numeric" pattern="[0-9]*" placeholder="…ou saisir un n°" autocomplete="off" aria-label="Saisir un numéro de projecteur"><button class="btn">Ajouter</button></form>
          <div class="sub" role="status">${esc(msg)}</div>` : ''}
        <div id="aerr" class="sub warn" role="alert">${esc(mode === 'pick' ? msg : '')}</div>
        <div class="row"><button class="btn primary grow" data-act="assign" ${staged.length ? '' : 'disabled'}>Assigner ${staged.length || ''} projecteur${staged.length > 1 ? 's' : ''}</button>
          <button class="btn" data-act="mode" data-v="view">Fermer</button></div></div>`;
    }

    const listTop = root.querySelector('.pick-list')?.scrollTop ?? 0, pageTop = window.scrollY, focusId = (document.activeElement as HTMLElement | null)?.dataset?.v;
    el.innerHTML = `<div class="card stack" style="border-left:10px solid ${showColor(show)}"><button class="fold" data-act="head-fold" aria-expanded="${!headFolded}" aria-label="${headFolded ? 'Déplier' : 'Replier'} l'en-tête du spectacle"><span aria-hidden="true">${headFolded ? '▸' : '▾'}</span> <h1>${esc(show.name)}</h1></button>
        <div class="sub">du ${fmtDay(show.start_date)} au ${fmtDay(show.end_date)}${show.start_date <= today && show.end_date >= today ? ' · <span class="tag run">en cours</span>' : show.end_date < today ? ' · terminé' : ''}</div>
        ${headFolded ? '' : `${show.note ? `<div>${esc(show.note)}</div>` : ''}
        ${(() => {                                                // interrupteur monté / démonté
          const mounted = showMounted(show, today), running = show.start_date <= today && show.end_date >= today, canMount = can('regisseur_general') && !running;
          return `<div class="mountsw"><button class="switch" role="switch" aria-checked="${mounted}" aria-label="Spectacle monté" data-act="mount" data-v="${mounted ? '0' : '1'}" ${canMount ? '' : 'disabled'}><span class="knob"></span></button>
            <b>${mounted ? 'Monté' : 'Démonté'}</b>
            <span class="sub">${running ? 'Spectacle en cours : toujours monté.' : canMount ? 'ON = projecteurs en place ; OFF = rangés en stock.' : 'Seuls les régisseurs généraux et les admins peuvent le changer.'}</span></div>`;
        })()}
        <div class="row wrap"><a class="btn patch-btn" href="#/patch/${esc(id)}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>Patch / Focus</a><button class="btn" data-act="prep" ${mine.length ? '' : 'disabled'}><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h8M9 9h3"/></svg>Générer la liste de prépa</button>
          <button class="btn" data-act="teardown"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10M18 15l2 2 3-4"/></svg>Rapport de démontage</button></div>
        ${canEdit ? `<div class="row wrap"><button class="btn" data-act="edit">Modifier</button><button class="btn" data-act="delete">Supprimer</button><button class="btn" data-act="copy-from">Utiliser le matériel d'un autre spectacle</button></div>` : ''}
        `}
        <div id="serr" class="sub warn" role="alert"></div></div>
      ${alertCard}
      ${wall}
      <div class="card sec sec-items"><div class="row wrap"><button class="fold grow" data-act="items-fold" aria-expanded="${!itemsFolded}" aria-label="${itemsFolded ? 'Déplier' : 'Replier'} les projecteurs affectés"><span aria-hidden="true">${itemsFolded ? '▸' : '▾'}</span> <h2>Projecteurs affectés (${mine.length})</h2></button>${itemsFolded && mine.some((x) => x.problem) ? `<span class="tag late">${mine.filter((x) => x.problem).length} indisponible${mine.filter((x) => x.problem).length > 1 ? 's' : ''}</span>` : ''}${canAssign && mode === 'view' && !itemsFolded ? '<button class="btn" data-act="mode" data-v="start">+ Affecter manuellement</button>' : ''}</div>
        ${canAssign && mode === 'view' ? `<button class="scan-btn" data-act="scanflow" aria-label="Scanner : préparer, affecter des positions ou patcher"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3"/><path class="scanline" d="M6 12h12"/></svg><span class="grow"><b>Scanner</b><small>Préparer · Affecter des positions · Patcher</small></span><span class="ai-chip">SCAN</span></button>` : ''}
        ${canAssign && mode === 'view' ? `<button class="ai-btn" data-act="preassign" aria-label="Pré-affecter depuis le spectacle précédent"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg><span class="grow"><b>Pré-affecter du spectacle précédent</b><small>Propose les projecteurs déjà montés</small></span><span class="ai-chip">AUTO</span></button>` : ''}
        ${itemsFolded ? '' : `${picker}
        <div class="mlist">${assigned || '<div class="empty">Aucun projecteur assigné</div>'}</div>`}</div>
      ${demandCard}
      <div class="card stack sec sec-reg"><div class="row wrap"><h2 class="grow">Régisseurs (${regs.length})</h2>${canEdit ? '<button class="btn" data-act="reg-add">+ Assigner</button>' : ''}</div>
        ${regs.map((r) => `<div class="stack reg"><div class="t">${esc(r.label)}</div>${canEdit ? `<div class="row wrap"><button class="btn" data-act="reg-mail" data-v="${r.user_id}">Inviter par mail</button><button class="btn" data-act="reg-del" data-v="${r.user_id}" aria-label="Retirer ${esc(r.label)}">Retirer</button></div>` : ''}</div>`).join('') || '<div class="sub">Aucun régisseur assigné : seuls les régisseurs généraux peuvent agir sur ce spectacle.</div>'}
        ${!canAssign && can('regisseur') ? '<div class="sub warn">Tu n\'es pas assigné à ce spectacle : consultation seulement.</div>' : ''}</div>`;
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
      sel.add(n); suggestLamp(n); msg = `N° ${n} ajouté au lot.`; navigator.vibrate?.(40); cashBeep();
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
    for (const n of [...lampBy.keys()]) if (!sel.has(n)) lampBy.delete(n);   // un PAR sorti du lot n'a plus de lampe à valider
    const status = root.querySelector('[role="status"]'); if (status) status.textContent = msg;
    const lot = root.querySelector('#lot');
    if (lot) lot.innerHTML = `Lot : ${staged.length ? staged.map((n) => `<button class="chip" data-act="toggle" data-v="${n}" aria-pressed="true">${n} ✕</button>`).join(' ') : 'vide'}`;
    const lr = root.querySelector('#lamprows'); if (lr) lr.innerHTML = lampRows(staged);   // la caméra n'est pas recréée
    const btn = root.querySelector<HTMLButtonElement>('[data-act="assign"]');
    if (btn) { btn.disabled = !staged.length; btn.textContent = `Assigner ${staged.length || ''} projecteur${staged.length > 1 ? 's' : ''}`; }
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
        if (t.id === 'q') { q = t.value; const pos = t.selectionStart; paint(root); const n = root.querySelector<HTMLInputElement>('#q'); n?.focus(); n?.setSelectionRange(pos, pos); }
      });
      root.addEventListener('change', (e) => { const t = e.target as HTMLSelectElement; if (t.id === 'lotpos') pos = t.value; else if (t.dataset?.lamp) lampBy.set(Number(t.dataset.lamp), t.value); });
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
        if (act === 'mode') {   /* « Affecter manuellement » : Scan QR sur téléphone (écran tactile), liste sur ordinateur */ mode = v === 'start' ? (window.matchMedia('(pointer: coarse)').matches ? 'scan' : 'pick') : (v as Mode); msg = ''; if (mode === 'view') { sel.clear(); lampBy.clear(); pos = ''; } paint(root); if (mode !== 'view') root.querySelector('.picker')?.scrollIntoView({ block: mode === 'scan' ? 'start' : 'nearest', behavior: 'smooth' }); }   // scan : la caméra en haut de l'écran, le lot visible dessous   // la fenêtre d'ajout s'ouvre en haut de la liste, bien visible
        else if (act === 'mount') { const r = await rpcCall('set_show_mounted', { p_show: id, p_value: v === '1' }); err(r.error ?? ''); }
        else if (act === 'type') { type = v ?? ''; paint(root); }
        else if (act === 'toggle') {
          const n = Number(v);
          if (el instanceof HTMLInputElement) { el.checked ? sel.add(n) : sel.delete(n); } else sel.delete(n);
          if (el instanceof HTMLInputElement && el.checked) suggestLamp(n);   // PAR ajouté : sa lampe montée est pré-sélectionnée, à chaque fois
          repaintKeepVideo(root);   // mise à jour sur place : la liste ne bouge pas
        }
        else if (act === 'assign') {
          const items = [...sel];
          const pars = items.filter(isPar);
          if (pars.some((n) => !lampBy.get(n))) { msg = 'Valide la lampe de chaque PAR du lot.'; const a = root.querySelector('#aerr'); if (a) a.textContent = msg; return; }
          // un appel par lampe (assign_items prend une seule lampe) ; les autres projecteurs partent sans lampe
          const groups = new Map<string, number[]>();
          for (const n of items) { const k = isPar(n) ? lampBy.get(n)! : ''; groups.set(k, [...(groups.get(k) ?? []), n]); }
          const added: number[] = [], skipped: { item: number; reason: string }[] = [];
          for (const [k, list] of groups) {
            const r = await rpcCall('assign_items', { p_show: id, p_items: list, p_lamp: k || null });
            if (r.error) { msg = r.error; const a = root.querySelector('#aerr'); if (a) a.textContent = (added.length ? `${added.length} déjà assigné(s). ` : '') + msg; if (added.length) paint(root); return; }
            const res = r.data as { added: number[]; skipped: { item: number; reason: string }[] } | null;
            added.push(...(res?.added ?? [])); skipped.push(...(res?.skipped ?? []));
          }
          // lampe changée pendant l'affectation : la fiche du projecteur est mise à jour aussi (même fonction que « passer en CPxx »)
          const lampNotes: string[] = [];
          for (const n of added.filter(isPar)) {
            const want = lampBy.get(n), cur = view().items.find((i) => i.id === n)?.lamp_id;
            if (!want || want === cur) continue;
            const r = await rpcCall('set_lamp', { p_item: n, p_lamp: want });
            lampNotes.push(r.error ? `n° ${n} : lampe non changée (${r.error})` : `n° ${n} → ${(view().lamps.find((l) => l.id === want)?.name ?? want)}`);
          }
          const lampNote = lampNotes.length ? ` Lampe mise à jour sur la fiche : ${lampNotes.join(' ; ')}.` : '';
          let posNote = '';
          if (pos && added.length) {   // position facultative : mise sur la feuille de patch de chaque projecteur assigné
            const p = await rpcCall('patch_batch', { p_show: id, p_targets: added.map((n) => ({ item: n })), p_op: 'field', p_value: { field: 'position', value: pos } });
            posNote = p.error ? ` Position non appliquée : ${p.error}` : ` Position ${pos} appliquée.`;
          }
          sel.clear(); lampBy.clear(); pos = ''; mode = 'view'; paint(root);
          err(`${added.length} assigné(s).` + lampNote + posNote + (skipped.length ? ' Refusés : ' + skipped.map((s) => `n° ${s.item} (${s.reason})`).join(' ; ') : ''));
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
            { name: 'model', label: 'Modèle', type: 'select', search: true, required: true, options: models.map((m): [string, string] => [m.id, `${tname(m) ? tname(m) + ' · ' : ''}${m.name}${stock(m.id) ? '' : ' (0 en stock : à louer / emprunter)'}`]) },
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
        else if (act === 'scanflow') { openScanFlow(id, () => paint(root)); }   // scan : affecter des positions / patcher
        else if (act === 'dem-slots') {   // répartition de la demande par zone / par position
          const x = view().showDemands.find((r) => r.id === v); if (!x) return;
          const m = view().models.find((r) => r.id === x.model_id), l = view().lamps.find((r) => r.id === x.lamp_id)?.name;
          const next = await openSlots(`Répartir : ${m?.name ?? '?'}${l ? ' ' + l : ''}`, x.qty, slotsOf(view(), x.id));
          if (!next) return;
          const r = await rpcCall('set_demand_slots', { p_demand: x.id, p_slots: next });
          if (r.error) { err(r.error); return; }
          err('');
        }
        else if (act === 'ext-add') {
          const dd = view(); const x = dd.showDemands.find((r) => r.id === v); const cs = dd.shows.find((r) => r.id === id); if (!x || !cs) return;
          const m = dd.models.find((r) => r.id === x.model_id);
          // 1re question : comment couvrir le manque ?
          const way = await openForm(`Gérer le manque : ${m?.name ?? ''}`, [
            { name: 'kind', label: 'Comment le couvrir ?', type: 'select', required: true, value: 'location', options: [['location', 'Loué chez…'], ['pret', 'Prêté par…'], ['sub', 'Substitution : un autre modèle']] }
          ], { submit: 'Suivant' });
          if (!way) return;
          if (way.kind === 'sub') {
            // modèles de remplacement : les modèles similaires d'abord, puis les autres ; « libres » = projecteurs sans panne, SAV, prêt ni autre spectacle aux dates
            const free = (modelId: string) => dd.items.filter((i) => i.model_id === modelId && !blockedReason(dd, i.id, cs)).length;
            const opts = dd.models.filter((o) => o.id !== x.model_id && dd.items.some((i) => i.model_id === o.id))
              .map((o) => ({ o, sim: similarNames(m?.name ?? '', o.name), n: free(o.id) }))
              .sort((p, q) => Number(q.sim) - Number(p.sim) || q.n - p.n || p.o.name.localeCompare(q.o.name, 'fr', { numeric: true }))
              .map(({ o, sim, n }) => [o.id, `${o.name}${sim ? ' (similaire)' : ''} · ${n} libre${n > 1 ? 's' : ''}`] as [string, string]);
            if (!opts.length) { err('Aucun autre modèle de projecteur en stock.'); return; }
            const f = await openForm(`Substitution : ${m?.name ?? ''}`, [
              { name: 'model', label: 'Remplacer par quel modèle ?', type: 'select', search: true, required: true, options: opts, hint: 'Les modèles similaires sont en premier. « libres » : projecteurs disponibles aux dates, sans tenir compte des objectifs des autres spectacles.' },
              { name: 'qty', label: 'Combien remplacer ?', type: 'number', min: '1', max: '500', required: true, value: String(Math.max(1, x.missing)) }
            ], { submit: 'Enregistrer', validate: (w) => !w.model ? 'Choisis un modèle.' : !/^\d+$/.test(w.qty) || Number(w.qty) < 1 ? 'Quantité invalide.' : null });
            if (!f) return;
            const r = await rpcCall('add_substitution', { p_show: id, p_demand: v, p_model: f.model, p_qty: Number(f.qty) });
            if (r.error) err(r.error); else toast(`Substitution enregistrée${(r.data as { missing?: number } | null)?.missing ? ' : il manque encore du matériel.' : ' : manque comblé.'}`, 'ok');
            return;
          }
          const f = await openForm(`${way.kind === 'pret' ? 'Prêt' : 'Location'} : ${m?.name ?? ''}`, [
            { name: 'who', label: way.kind === 'pret' ? 'Nom du prêteur' : 'Nom du loueur', required: true },
            { name: 'qty', label: 'Quantité', type: 'number', min: '1', max: '500', required: true, value: String(x.missing) },
            { name: 'from', label: 'Date de livraison', type: 'date', required: true, value: cs.start_date },
            { name: 'to', label: 'Date de reprise', type: 'date', required: true, value: cs.end_date }
          ], { submit: 'Enregistrer', validate: (w) => !w.who ? 'Indique le nom du prêteur / loueur.' : !/^\d+$/.test(w.qty) || Number(w.qty) < 1 ? 'Quantité invalide.' : !w.from || !w.to || w.to < w.from ? 'La reprise doit être le même jour ou après la livraison.' : null });
          if (!f) return;
          const r = await rpcCall('add_external', { p_show: id, p_demand: v, p_kind: way.kind, p_provider: f.who, p_qty: Number(f.qty), p_from: f.from, p_to: f.to, p_note: null });
          if (r.error) err(r.error); else toast(`${way.kind === 'pret' ? 'Prêt' : 'Location'} enregistré${(r.data as { missing?: number } | null)?.missing ? ' : il manque encore du matériel.' : ' : manque comblé.'}`, 'ok');
        }
        else if (act === 'dgel-add') {
          const x = view().showDemands.find((r) => r.id === v); if (!x) return;
          const m = view().models.find((r) => r.id === x.model_id);
          const f = await openForm(`Gélatines demandées : ${m?.name ?? ''}`, [
            { name: 'refs', label: 'Référence(s) du gel', required: true, hint: 'Plusieurs gels sur le même projecteur : L201 + R119, ou L200, R114, ou L281+#132. Une référence déjà demandée voit sa quantité additionnée.' },
            { name: 'qty', label: `Sur combien de projecteurs ? (demande de ${x.qty})`, type: 'number', min: '1', max: String(x.qty), required: true, value: String(x.qty) }
          ], { submit: 'Ajouter', validate: (w) => !splitGelRefs(w.refs).length ? 'Indique au moins une référence.' : splitGelRefs(w.refs).length > 10 ? '10 références au maximum.'
            : !/^\d+$/.test(w.qty.trim()) || Number(w.qty) < 1 || Number(w.qty) > x.qty ? `Quantité : un nombre entre 1 et ${x.qty}.` : null });
          if (!f) return;
          const gels = splitGelRefs(f.refs).map((ref) => ({ ref, color: gelColorOf(ref) }));   // la couleur est déduite de chaque référence
          const r = await rpcCall('add_demand_gels', { p_show: id, p_demand: v, p_gels: gels, p_qty: Number(f.qty) });
          if (r.error) err(r.error); else toast(`${gels.length > 1 ? gels.length + ' gels demandés' : 'Gel demandé'} sur ${f.qty} projecteur${Number(f.qty) > 1 ? 's' : ''}.`, 'ok');
        }
        else if (act === 'dgel-del') {
          const r = await rpcCall('delete_demand_gel', { p_id: v });
          if (r.error) err(r.error);
        }
        else if (act === 'sub-del') {
          if (!window.confirm('Retirer cette substitution ? Le manque réapparaîtra.')) return;
          const r = await rpcCall('delete_substitution', { p_id: v });
          if (r.error) err(r.error);
        }
        else if (act === 'ext-del') {
          if (!window.confirm('Retirer ce prêt / cette location ? Le manque réapparaîtra.')) return;
          const r = await rpcCall('delete_external', { p_id: v });
          if (r.error) err(r.error);
        }
        else if (act === 'dem-del') {
          const x = view().showDemands.find((r) => r.id === v); if (!x) return;
          if (!window.confirm('Supprimer cette demande ? Les projecteurs assignés automatiquement seront libérés (ceux que tu as choisis restent).')) return;
          await sendDemand(x.model_id, x.lamp_id ?? '', 0);
        }
        else if (act === 'gel-del') {
          const r = await rpcCall('delete_gel', { p_id: v });
          if (r.error) err(r.error);
        }
        else if (act === 'rtoggle') { const n = Number(v); if (rsel.has(n)) rsel.delete(n); else rsel.add(n); paint(root); }
        else if (act === 'rall') {
          const dd = view();   // « Tout cocher » agit sur les lignes affichées (donc sur le type filtré, s'il y en a un)
          const all = dd.showItems.filter((r) => r.show_id === id && (!modelFilter || dd.items.find((i) => i.id === r.item_id)?.model_id === modelFilter)).map((r) => r.item_id);
          if (all.length && all.every((n) => rsel.has(n))) all.forEach((n) => rsel.delete(n)); else all.forEach((n) => rsel.add(n));
          paint(root);
        }
        else if (act === 'preassign') {   // pré-affectation automatique depuis un spectacle précédent
          const cur = view().shows.find((x) => x.id === id); if (!cur) return;
          await sparkle(el);
          const list = previousShows(view(), cur);
          if (!list.length) { err('Aucun spectacle précédent.'); return; }
          const day = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
          const def = defaultPrevious(list, todayStr());
          const f = await openForm('Pré-affecter du spectacle précédent', [
            { name: 'prev', label: 'Spectacle précédent', type: 'select', required: true, value: def?.id, options: list.map((x): [string, string] => [x.id, `${x.name} (${day(x.start_date)} au ${day(x.end_date)})`]), hint: 'On pioche d\'abord dans ses projecteurs montés, selon le « Matériel demandé ».' }
          ], { submit: 'Calculer' });
          if (!f) return;
          const prevShow = list.find((x) => x.id === f.prev); if (!prevShow) return;
          const plan = preAssignPlan(view(), cur, prevShow);
          if (!(await previewPlan(view(), plan, cur.name, prevShow.name))) return;
          // un appel par lampe ET par zone (assign_items prend une seule lampe et une seule zone)
          const groups = new Map<string, number[]>();
          for (const p of plan.proposals) { const k = `${p.lamp ?? ''}|${p.zone}`; groups.set(k, [...(groups.get(k) ?? []), p.item]); }
          let n = 0; const skipped: { item: number; reason: string }[] = [];
          for (const [k, itemsList] of groups) {
            const [lampId, zone] = k.split('|');
            const r = await rpcCall('assign_items', { p_show: id, p_items: itemsList, p_lamp: lampId || null, ...(zone ? { p_zone: zone } : {}) });   // p_zone seulement s'il est précisé
            if (r.error) { err((n ? `${n} affecté(s). ` : '') + r.error); if (n) paint(root); return; }
            const res = r.data as { added: number[]; skipped: { item: number; reason: string }[] } | null;
            n += res?.added.length ?? 0; skipped.push(...(res?.skipped ?? []));
          }
          paint(root);
          const m = `${n} projecteur${n > 1 ? 's' : ''} pré-affecté${n > 1 ? 's' : ''}.` + (skipped.length ? ` Non affectés : ${skipped.map((x) => `${x.item} (${x.reason})`).join(', ')}.` : '');
          err(skipped.length ? m : ''); if (!skipped.length) toast(m);
          void sparkle(root.querySelector<HTMLElement>('.ai-btn') ?? el, 700);
        }
        else if (act === 'head-fold') { headFolded = !headFolded; paint(root); }   // replie / déplie l'en-tête de la fiche
        else if (act === 'items-fold') { itemsFolded = !itemsFolded; rsel.clear(); paint(root); }   // replie / déplie les projecteurs affectés
        else if (act === 'wall-fold') { wallFolded = !wallFolded; paint(root); }   // replie / déplie le mur
        else if (act === 'dem-fold') { demFolded = !demFolded; paint(root); }   // replie / déplie le matériel demandé
        else if (act === 'rmodel') {
          rsel.clear(); modelFilter = modelFilter === v ? '' : (v ?? '');   // un appui déploie ce modèle (et replie le précédent) ; un second appui le replie
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
          const list = rows.map((r) => r.item_id).sort((a, b) => a - b);
          if (!list.length) return;
          if (!window.confirm(`Retirer ${list.length} projecteur${list.length > 1 ? 's' : ''} de ce spectacle (${list.join(', ')}) ?`)) return;
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
            await deliverPdf(blob, filename, 'Liste de prépa prête');
          } catch (e) { err('Impossible de générer le PDF : ' + String(e)); }
        }
        else if (act === 'teardown') {
          const d = view();
          const others = sortShows(d.shows.filter((s) => s.id !== id), todayStr());
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
            await deliverPdf(blob, filename, 'Rapport de démontage prêt');
          } catch (e) { err('Impossible de générer le PDF : ' + String(e)); }
        }
        else if (act === 'wall-person') {
          const ppl = (await loadPeople()).filter((p) => p.id !== state.profile?.id);
          if (!ppl.length) { wallErr('Annuaire indisponible (connexion requise).'); return; }
          const f = await openForm('Citer une personne', [{ name: 'p', label: 'Personne', type: 'select', search: true, options: ALL_OPT().concat(ppl.map((p): [string, string] => [p.id, p.label])), required: true }], { submit: 'Citer' });
          if (f) insertAtCursor(f.p === '@all' ? '@all ' : '@' + (ppl.find((p) => p.id === f.p)?.label ?? '') + ' ');
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
          const pid = uuid();
          const r = await rpcCall('post_show_message', { p_id: pid, p_show: id, p_body: fromEditable(text, ppl) });
          if (r.error) wallErr(r.error); else { ta.value = ''; wallErr(''); notifyPost(pid); }
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
        else if (act === 'copy-from') {   // repartir du matériel (et au choix de la feuille de patch) d'un autre spectacle : régisseurs généraux et admins
          const day = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
          const others = view().shows.filter((x) => x.id !== id).sort((a, b) => b.start_date.localeCompare(a.start_date));   // tous les spectacles, les plus récents d'abord
          if (!others.length) { err('Il n\'y a pas d\'autre spectacle.'); return; }
          const nItems = view().showItems.filter((x) => x.show_id === id).length, nLines = view().patchLines.filter((l) => l.show_id === id && l.item_id !== null).length;
          const has = nItems > 0 || nLines > 0;   // le spectacle a déjà du matériel : on demande quoi faire
          const yn: [string, string][] = [['oui', 'Oui'], ['non', 'Non']];
          const f = await openForm('Utiliser le matériel d\'un autre spectacle', [
            { name: 'src', label: 'Spectacle à recopier', type: 'select', search: true, required: true, options: others.map((x): [string, string] => [x.id, `${x.name} (${day(x.start_date)} au ${day(x.end_date)})`]), hint: 'Les projecteurs assignés sont recopiés. Le matériel demandé, les locations et les prêts ne le sont pas.' },
            { name: 'circ', label: 'Garder les circuits de la feuille de patch ?', type: 'select', options: yn, value: 'oui', hint: 'La grada, la courbe, le DMX, la position et les notes sont toujours gardés. L\'état (vert / rouge) est remis à vide.' },
            { name: 'gels', label: 'Garder les gélatines et les accessoires ?', type: 'select', options: yn, value: 'oui' },
            ...(has ? [{ name: 'mode', label: `⚠ Ce spectacle a déjà ${nItems} projecteur${nItems > 1 ? 's' : ''} et ${nLines} ligne${nLines > 1 ? 's' : ''} de patch. Que faire ?`, type: 'select' as const, required: true, options: [['', 'Choisis…'], ['add', 'Compléter : j\'ajoute, sans toucher à l\'existant'], ['replace', 'Remplacer : je retire d\'abord les projecteurs déjà là']] as [string, string][], hint: 'Les lignes de patch sans projecteur (locations, prêts, à louer) restent en place dans les deux cas.' }] : [])
          ], { submit: 'Recopier', validate: (v) => (has && !v.mode ? 'Choisis : compléter ou remplacer.' : null) });
          if (!f) return;
          const mode = has ? f.mode : 'add';
          if (mode === 'replace' && !window.confirm(`Retirer les ${nItems} projecteur${nItems > 1 ? 's' : ''} de ce spectacle avant de recopier ?`)) return;
          const r = await rpcCall('show_copy_from', { p_target: id, p_source: f.src, p_mode: mode, p_circuits: f.circ !== 'non', p_gels: f.gels !== 'non' });
          if (r.error) { err(r.error); return; }
          const res = r.data as { added: number[]; skipped: { item: number; reason: string }[]; lines: number } | null;
          const sk = res?.skipped ?? [];
          const msg = `${res?.added.length ?? 0} projecteur${(res?.added.length ?? 0) > 1 ? 's' : ''} recopié${(res?.added.length ?? 0) > 1 ? 's' : ''}.` + (sk.length ? ` Non recopiés (${sk.length}) : ${sk.map((x) => `${x.item} (${x.reason})`).join(', ')}.` : '');
          err(sk.length ? msg : ''); if (!sk.length) toast(msg);
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
