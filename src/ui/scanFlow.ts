// Écran de scan du spectacle : menu « Affecter des positions » / « Patcher », puis le mode choisi.
import QrScanner from 'qr-scanner';
import { startScan } from './torch';
import { POSITION_GROUPS } from '../patch';
import { rpcCall, upsertPatchLine, view } from '../store';
import { supabase } from '../supabase';
import type { PatchLine } from '../patch';
import { parseScan } from '../logic';
import { classifyScan, isParItem, splitLot } from '../scanPositions';
import { prepScanTarget, remainingNeeds } from '../prepNeeds';
import { zoneLabel } from '../zones';
import { entryOf, entryOps, keypad } from '../patchEntry';
import type { Entry } from '../patchEntry';
import { cashBeep } from './beep';
import { toast } from './toast';
import { confirmBox } from './dialog';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

/** Ouvre l'écran de scan pour un spectacle ; `onChange` est rappelé après chaque modification (pour rafraîchir la fiche). */
export function openScanFlow(showId: string, onChange: () => void): void {
  const dlg = el('dialog', 'dlg scanflow'); document.body.appendChild(dlg);
  let stop = () => {};
  const close = () => { stop(); dlg.close(); dlg.remove(); onChange(); };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });   // Échap / retour : on ferme proprement (caméra coupée)

  /** Menu de départ : trois gros choix. */
  function menu() {
    stop(); stop = () => {};
    const h = el('h2', '', 'Scanner'); h.tabIndex = -1;
    // trois gros boutons colorés avec leur icône : Patcher, Affecter des positions, Préparer (dans cet ordre)
    const choice = (cls: string, title: string, sub: string, icon: string, go: () => void) => {
      const c = el('button', `scan-choice fancy ${cls}`); c.type = 'button';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'ico'); svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = icon;                                       // dessin fixe écrit ici, jamais du texte venant d'un utilisateur
      const t = el('span', 'grow'); t.append(el('b', '', title), el('small', '', sub));
      c.append(svg, t); c.addEventListener('click', go); return c;
    };
    const b = choice('c-patch', 'Patcher', 'Scanner, taper la grada, DIRECT et DMX', '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>', patcher);
    const a = choice('c-pos', 'Affecter des positions', 'Choisir une position, scanner le lot, valider', '<path d="M12 21s-6-5.4-6-10a6 6 0 0112 0c0 4.6-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/>', positions);
    const pr = choice('c-prep', 'Préparer', 'Scanner les projecteurs sortis du stock : affectés à la bonne ligne', '<path d="M3 8l9-5 9 5v9l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v9"/>', prepare);
    const q = el('button', 'btn', 'Quitter'); q.type = 'button'; q.addEventListener('click', close);
    dlg.replaceChildren(h, b, a, pr, q); h.focus();
  }

  /** Affecter des positions : position choisie, scan des projecteurs, validation. */
  function positions() {
    const lot: number[] = []; let pos = '';
    const h = el('h2', '', 'Affecter des positions'); h.tabIndex = -1;
    const vp = el('div', 'viewport'); const video = document.createElement('video'); video.setAttribute('playsinline', ''); video.muted = true; vp.appendChild(video);
    const sel = el('select'); sel.setAttribute('aria-label', 'Position du lot');
    sel.append(new Option('— choisis la position —', ''));
    for (const g of POSITION_GROUPS) { const og = document.createElement('optgroup'); og.label = g.label; for (const p of g.items) og.appendChild(new Option(p, p)); sel.appendChild(og); }
    const lotBox = el('div', 'chips scan-lot'); const msg = el('div', 'sub'); msg.setAttribute('role', 'status');
    const form = el('form', 'row'); const inp = el('input'); inp.inputMode = 'numeric'; inp.pattern = '[0-9]*'; inp.placeholder = '…ou saisir un n°'; inp.setAttribute('aria-label', 'Saisir un numéro de projecteur'); inp.autocomplete = 'off';
    const addB = el('button', 'btn', 'Ajouter'); form.append(inp, addB);
    const ok = el('button', 'btn primary grow', ''); ok.type = 'button';
    const back = el('button', 'btn', 'Retour'); back.type = 'button';
    const row = el('div', 'row wrap'); row.append(ok, back);
    const foot = el('div', 'slot-foot stack'); foot.append(row);
    dlg.replaceChildren(h, sel, vp, lotBox, form, msg, foot);
    const say = (t: string, bad = false) => { msg.textContent = t; msg.classList.toggle('warn', bad); if (bad) navigator.vibrate?.([250, 100, 250]); };
    const refresh = () => {
      lotBox.replaceChildren(...(lot.length ? lot.map((n) => { const c = el('button', 'chip', `${n} ✕`); c.type = 'button'; c.setAttribute('aria-pressed', 'true'); c.setAttribute('aria-label', `Retirer le n° ${n} du lot`);
        c.addEventListener('click', () => { lot.splice(lot.indexOf(n), 1); refresh(); }); return c; }) : [el('span', 'sub', 'Lot vide')]));
      ok.disabled = !lot.length || !pos; ok.textContent = pos ? `Affecter ${lot.length || ''} projecteur${lot.length > 1 ? 's' : ''} à ${pos}` : 'Choisis d\'abord une position';
    };
    sel.addEventListener('change', () => { pos = sel.value; refresh(); });
    const add = (text: string) => {
      if (!pos) { say('Choisis d\'abord la position.', true); return; }
      const n = parseScan(text), v = classifyScan(view(), showId, n, lot);
      if (!v.ok) { say(v.msg, true); return; }
      lot.push(n as number); say(`N° ${n} ajouté${v.inShow ? '' : ' (pas encore affecté au spectacle : il le sera à la validation)'}.`); navigator.vibrate?.(40); cashBeep(); refresh();
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); add(inp.value); inp.value = ''; });
    back.addEventListener('click', menu);
    ok.addEventListener('click', async () => {
      const { inShow, out, noLamp } = splitLot(view(), showId, lot);
      const outAll = [...out.values()].flat();
      if (noLamp.length) { say(`PAR sans lampe sur la fiche (n° ${noLamp.join(', ')}) : retire-les ou renseigne leur lampe.`, true); return; }
      if (outAll.length && !await confirmBox(`${outAll.length} projecteur${outAll.length > 1 ? 's ne sont pas encore affectés' : ' n\'est pas encore affecté'} à ce spectacle (n° ${outAll.join(', ')}). Les affecter et leur donner la position ${pos} ?`)) return;
      ok.disabled = true; const done = [...inShow], refused: string[] = [];
      for (const [lamp, list] of out) {   // affectation d'abord (un appel par lampe), puis position pour tous
        const r = await rpcCall('assign_items', { p_show: showId, p_items: list, p_lamp: lamp || null });
        if (r.error) { say(r.error, true); refresh(); return; }
        const res = r.data as { added: number[]; skipped: { item: number; reason: string }[] } | null;
        done.push(...(res?.added ?? [])); refused.push(...(res?.skipped ?? []).map((s) => `n° ${s.item} (${s.reason})`));
      }
      const p = done.length ? await rpcCall('patch_batch', { p_show: showId, p_targets: done.map((n) => ({ item: n })), p_op: 'field', p_value: { field: 'position', value: pos } }) : { error: null };
      if (p.error) { say(`Position non appliquée : ${p.error}`, true); refresh(); return; }
      toast(`${done.length} projecteur${done.length > 1 ? 's' : ''} → ${pos}${refused.length ? ' · refusés : ' + refused.join(' ; ') : ''}`);
      lot.length = 0; sel.value = ''; pos = ''; say(refused.length ? 'Refusés : ' + refused.join(' ; ') : `Fait. Choisis la position suivante, ou retourne au menu.`, refused.length > 0); refresh(); onChange();
    });
    refresh(); say('Choisis la position, puis scanne les projecteurs un par un.');
    // caméra en haut ; coupée quand on quitte l'écran
    let last = '', lastAt = 0;
    const scanner = new QrScanner(video, (r) => { if (r.data === last && Date.now() - lastAt < 2500) return; last = r.data; lastAt = Date.now(); add(r.data); },
      { returnDetailedScanResult: true, preferredCamera: 'environment', maxScansPerSecond: 8, highlightScanRegion: false });
    startScan(scanner, video).catch((e) => say(`Caméra indisponible (${String(e)}). Saisis les numéros à la main.`, true));
    stop = () => { scanner.stop(); scanner.destroy(); };
    h.focus();
  }

  /** Préparer : chaque projecteur scanné est affecté tout de suite à la ligne de demande encore incomplète (zone selon son stock d'origine). */
  function prepare() {
    stop(); stop = () => {};
    const h = el('h2', '', 'Préparer'); h.tabIndex = -1;
    const vp = el('div', 'viewport'); const video = document.createElement('video'); video.setAttribute('playsinline', ''); video.muted = true; vp.appendChild(video);
    const left = el('div', 'sub'); const msg = el('div', 'sub'); msg.setAttribute('role', 'status');
    const form = el('form', 'row'); const inp = el('input'); inp.inputMode = 'numeric'; inp.pattern = '[0-9]*'; inp.placeholder = '…ou saisir un n°'; inp.setAttribute('aria-label', 'Saisir un numéro de projecteur');
    form.append(inp, el('button', 'btn', 'Affecter'));
    const bk = el('button', 'btn', 'Retour au menu'); bk.type = 'button'; bk.addEventListener('click', menu);
    const row = el('div', 'row wrap'); row.append(bk);
    dlg.replaceChildren(h, vp, left, form, msg, row);
    const say = (t: string, bad = false) => { msg.textContent = t; msg.classList.toggle('warn', bad); if (bad) navigator.vibrate?.([250, 100, 250]); };
    const names = (modelId: string, lamp: string | null) => `${view().models.find((m) => m.id === modelId)?.name ?? '?'}${lamp ? ' ' + (view().lamps.find((l) => l.id === lamp)?.name ?? '') : ''}`;
    // ce qui reste à préparer, remis à jour après chaque affectation
    const showLeft = () => {
      const sh = view().shows.find((x) => x.id === showId); if (!sh) return;
      const r = remainingNeeds(view(), sh);
      const parts = r.prep.map((x) => `${x.n} × ${names(x.modelId, x.lamp)}${x.zone ? ' (' + zoneLabel(x.zone) + ')' : ''} ← ${x.from === 'stock3' ? '3e' : 'dessous'}`);
      left.textContent = parts.length || r.unavailable.length ? 'Reste à préparer : ' + [...parts, ...r.unavailable.map((x) => `${x.n} × ${names(x.modelId, x.lamp)} introuvable`)].join(' · ') : 'Rien d\'autre à préparer : la demande est complète.';
    };
    let busy = false;
    const go = async (text: string) => {
      if (busy) return;
      const sh = view().shows.find((x) => x.id === showId), n = parseScan(text);
      if (!sh) return;
      if (n === null) { say('QR non reconnu.', true); return; }
      const t = prepScanTarget(view(), sh, n);
      if (!t.ok) { say(t.msg, true); return; }
      busy = true;
      try {
        if (t.ask && !await confirmBox(t.ask)) { say(`N° ${n} non affecté.`); return; }
        const r = await rpcCall('assign_items', { p_show: showId, p_items: [n], p_lamp: t.lamp, ...(t.zone ? { p_zone: t.zone } : {}) });   // p_zone seulement s'il est précisé
        if (r.error) { say(r.error, true); return; }
        const res = r.data as { added: number[]; skipped: { item: number; reason: string }[] } | null;
        if (res?.skipped.length) { say(`N° ${n} refusé : ${res.skipped[0].reason}`, true); return; }
        navigator.vibrate?.(40); cashBeep();
        say(`N° ${n} → ${names(view().items.find((i) => i.id === n)?.model_id ?? '', t.lamp)}${t.zone ? ' · ' + zoneLabel(t.zone) : ''}${t.relamp ? ' · à relamper' : ''}.`);
        showLeft(); onChange();
      } finally { busy = false; }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); const v = inp.value; inp.value = ''; void go(v); });
    showLeft(); say('Scanne chaque projecteur sorti du stock.');
    let last = '', lastAt = 0;
    const scanner = new QrScanner(video, (r) => { if (r.data === last && Date.now() - lastAt < 2500) return; last = r.data; lastAt = Date.now(); void go(r.data); },
      { returnDetailedScanResult: true, preferredCamera: 'environment', maxScansPerSecond: 8, highlightScanRegion: false });
    startScan(scanner, video).catch((e) => say(`Caméra indisponible (${String(e)}). Saisis les numéros à la main.`, true));
    stop = () => { scanner.stop(); scanner.destroy(); };
    h.focus();
  }

  /** Patcher : scan d'un projecteur, pavé numérique pour la grada, DIRECT + adresse DMX (univers / adresse), puis Suivant. */
  function patcher() {
    stop(); stop = () => {};
    let mode: 'dimmer' | 'circuit' = 'dimmer';   // ce que l'on saisit : la grada (par défaut) ou le circuit ; gardé d'un projecteur à l'autre
    const scanning = () => {
      stop();
      const h = el('h2', '', 'Patcher'); h.tabIndex = -1;
      const vp = el('div', 'viewport'); const video = document.createElement('video'); video.setAttribute('playsinline', ''); video.muted = true; vp.appendChild(video);
      const msg = el('div', 'sub'); msg.setAttribute('role', 'status');
      const form = el('form', 'row'); const inp = el('input'); inp.inputMode = 'numeric'; inp.pattern = '[0-9]*'; inp.placeholder = '…ou saisir un n°'; inp.setAttribute('aria-label', 'Saisir un numéro de projecteur'); inp.autocomplete = 'off';
      form.append(inp, el('button', 'btn', 'Ouvrir'));
      const q = el('button', 'btn', 'Quitter'); q.type = 'button'; q.addEventListener('click', close);
      const bk = el('button', 'btn', 'Retour au menu'); bk.type = 'button'; bk.addEventListener('click', menu);
      const row = el('div', 'row wrap'); row.append(bk, q);
      // interrupteur à deux positions : GRADA (par défaut) / CIRCUIT
      const sw = el('div', 'seg two'); sw.setAttribute('role', 'group'); sw.setAttribute('aria-label', 'Ce que tu saisis');
      const swBtn = (m: typeof mode, label: string) => { const b = el('button', '', label); b.type = 'button'; b.addEventListener('click', () => { mode = m; paintSw(); }); return { m, b }; };
      const sws = [swBtn('dimmer', 'GRADA'), swBtn('circuit', 'CIRCUIT')];
      const paintSw = () => { for (const x of sws) { x.b.setAttribute('aria-pressed', String(mode === x.m)); x.b.classList.toggle('on', mode === x.m); } say(mode === 'circuit' ? 'Scanne un projecteur pour saisir son circuit.' : 'Scanne un projecteur pour le patcher.'); };
      sw.append(...sws.map((x) => x.b));
      dlg.replaceChildren(h, vp, sw, form, msg, row);
      const say = (t: string, bad = false) => { msg.textContent = t; msg.classList.toggle('warn', bad); if (bad) navigator.vibrate?.([250, 100, 250]); };
      paintSw();
      const open = async (text: string) => {
        const n = parseScan(text), v = classifyScan(view(), showId, n, []);
        if (!v.ok) { say(v.msg, true); return; }
        const num = n as number;
        if (!v.inShow) {   // pas encore affecté : confirmation puis affectation (PAR : lampe de sa fiche)
          const { out, noLamp } = splitLot(view(), showId, [num]);
          if (noLamp.length) { say(`Le PAR n° ${num} n'a pas de lampe sur sa fiche : renseigne-la d'abord.`, true); return; }
          if (!await confirmBox(`Le n° ${num} n'est pas encore affecté à ce spectacle. L'affecter ?`)) return;
          const [[lamp, list]] = [...out.entries()];
          const r = await rpcCall('assign_items', { p_show: showId, p_items: list, p_lamp: lamp || null });
          const res = r.data as { added: number[]; skipped: { item: number; reason: string }[] } | null;
          if (r.error || !(res?.added ?? []).includes(num)) { say(r.error ?? `N° ${num} refusé : ${res?.skipped?.[0]?.reason ?? 'impossible'}.`, true); return; }
          onChange();
        }
        // valeurs actuelles : on relit la ligne de patch sur le serveur (la copie de ce téléphone peut dater), pour pré-remplir le clavier avec la grada / le circuit déjà saisis
        try { if (navigator.onLine) { const { data } = await supabase.from('patch_lines').select('*').eq('show_id', showId).eq('item_id', num).maybeSingle(); if (data) upsertPatchLine(data as PatchLine); } } catch { /* hors ligne : on garde la copie locale */ }
        navigator.vibrate?.(40); cashBeep(); editing(num);
      };
      form.addEventListener('submit', (e) => { e.preventDefault(); void open(inp.value); inp.value = ''; });
      let last = '', lastAt = 0;
      const scanner = new QrScanner(video, (r) => { if (r.data === last && Date.now() - lastAt < 2500) return; last = r.data; lastAt = Date.now(); void open(r.data); },
        { returnDetailedScanResult: true, preferredCamera: 'environment', maxScansPerSecond: 8, highlightScanRegion: false });
      startScan(scanner, video).catch((e) => say(`Caméra indisponible (${String(e)}). Saisis le numéro à la main.`, true));
      stop = () => { scanner.stop(); scanner.destroy(); };
      h.focus();
    };

    const editing = (item: number) => {
      stop(); stop = () => {};   // caméra coupée pendant la saisie
      const d0 = view(), before: Entry = entryOf(d0, showId, item); let cur: Entry = { ...before };
      let active: 'circuit' | 'dimmer' | 'universe' | 'address' = mode === 'circuit' ? 'circuit' : 'dimmer'; let fresh = true;   // fresh : le 1er chiffre tapé remplace la valeur du champ (comme une calculette)
      const it = d0.items.find((i) => i.id === item), model = d0.models.find((m) => m.id === it?.model_id)?.name ?? '?';
      const lampName = isParItem(d0, item) ? d0.lamps.find((l) => l.id === d0.showItems.find((s) => s.show_id === showId && s.item_id === item)?.lamp_id)?.name : '';
      const pos = d0.patchLines.find((l) => l.show_id === showId && l.item_id === item)?.position;
      const h = el('h2', '', `N° ${item}`); h.tabIndex = -1;
      const info = el('div', 'sub', `${model}${lampName ? ' ' + lampName : ''}${pos ? ' · ' + pos : ''}`);
      const already = before.circuit || before.dimmer || before.direct ? `Déjà patché : ${before.circuit ? 'circuit ' + before.circuit + ' · ' : ''}grada ${before.dimmer || '—'}${before.direct ? ' · DIRECT' + (before.universe ? ` ${before.universe}-${before.address}` : '') : ''}. Tu peux modifier.` : 'Pas encore patché.';
      const state = el('div', 'sub', already); state.setAttribute('role', 'status');
      const fields = el('div', 'pe-fields');
      const mk = (k: typeof active, label: string) => { const b = el('button', 'pe-field'); b.type = 'button'; b.append(el('small', '', label), el('b', 'pe-val')); b.addEventListener('click', () => { active = k; fresh = true; paint(); }); return { k, b }; };
      const fc = mk('circuit', 'CIRCUIT'), fg = mk('dimmer', 'GRADA'), fu = mk('universe', 'UNIVERS'), fa = mk('address', 'ADRESSE');
      const pad = el('div', 'pe-pad');
      for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back']) {
        const b = el('button', 'btn pe-key', k === 'clear' ? 'C' : k === 'back' ? '⌫' : k); b.type = 'button'; b.setAttribute('aria-label', k === 'clear' ? 'Tout effacer' : k === 'back' ? 'Effacer le dernier chiffre' : `Chiffre ${k}`);
        b.addEventListener('click', () => { const base = fresh && /^\d$/.test(k) ? '' : cur[active]; fresh = false; cur = { ...cur, [active]: keypad(base, k, active === 'universe' || active === 'address' ? 3 : 6) }; paint(); }); pad.appendChild(b);
      }
      const dir = el('button', 'pe-direct'); dir.type = 'button';
      dir.addEventListener('click', () => { cur = { ...cur, direct: !cur.direct }; active = cur.direct ? 'universe' : 'dimmer'; fresh = true; if (cur.direct && !cur.universe) cur.universe = '1'; paint(); });   // univers 1 proposé
      const err = el('div', 'sub warn'); err.setAttribute('role', 'alert');
      const next = el('button', 'btn primary grow', 'Suivant'); next.type = 'button';
      const quit = el('button', 'btn', 'Quitter'); quit.type = 'button'; quit.addEventListener('click', close);
      const row = el('div', 'row wrap'); row.append(next, quit);
      const foot = el('div', 'slot-foot stack'); foot.append(err, row);
      function paint() {
        for (const f of [fc, fg, fu, fa]) { f.b.classList.toggle('on', f.k === active); f.b.classList.toggle('fresh', f.k === active && fresh); f.b.querySelector('.pe-val')!.textContent = cur[f.k] || '—'; f.b.hidden = mode === 'circuit' ? f.k !== 'circuit' : f.k === 'circuit' || (f.k !== 'dimmer' && !cur.direct); }   // mode circuit : seul le circuit ; mode grada : grada + DMX si DIRECT
        fields.replaceChildren(fc.b, fg.b, fu.b, fa.b); dir.hidden = mode === 'circuit';
        dir.textContent = cur.direct ? 'DIRECT ✓ (toucher pour retirer)' : 'DIRECT'; dir.classList.toggle('on', cur.direct);
        const ops = entryOps(before, cur); err.textContent = 'error' in ops ? ops.error : '';
      }
      next.addEventListener('click', async () => {
        const ops = entryOps(before, cur);
        if ('error' in ops) { err.textContent = ops.error; navigator.vibrate?.([250, 100, 250]); return; }
        next.disabled = true;
        for (const o of ops) {
          const r = await rpcCall('set_patch_field', { p_show: showId, p_item: item, p_line: null, p_field: o.field, p_value: o.value });
          if (r.error) { err.textContent = r.error; next.disabled = false; return; }   // on reste ici : rien n'est perdu
        }
        if (ops.length) { const dm = cur.direct && cur.universe && cur.address ? ` · DIRECT ${cur.universe}-${cur.address}` : cur.direct ? ' · DIRECT' : ''; toast(`N° ${item} patché${cur.circuit ? ' · circuit ' + cur.circuit : ''}${cur.dimmer ? ' · grada ' + cur.dimmer : ''}${dm}`); onChange(); }
        scanning();
      });
      dlg.replaceChildren(h, info, state, fields, pad, dir, foot); paint(); h.focus();
    };
    scanning();
  }

  menu(); dlg.showModal();
}
