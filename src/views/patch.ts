import type { ViewFactory } from '../router';
import { can, canActShow, reportFault, rpcCall, view } from '../store';
import { supabase } from '../supabase';
import { esc, fmtDateTime, parseScan } from '../logic';
import { gelCss } from '../types';
import { gelColorOf } from '../gels';
import { ACCESSORIES, COLS, CURVES, POSITIONS, buildRows, editableCols, labelsOf, sortRows } from '../patch';
import type { Col, PatchLine, PatchRow } from '../patch';
import { fmtDay } from './agenda';
import { openForm } from '../ui/dialog';
import { toast } from '../ui/toast';
import { blockedReason } from '../alerts';
import { describe } from '../ref';
import { rankStock, similarNames } from '../patchSuggest';
import type { Suggestion } from '../patchSuggest';

/** Feuille de patch / focus d'un spectacle : une ligne par projecteur affecté, saisie directe, tri par colonne. */
export const patchView: ViewFactory = ([showId]) => {
  let lines: PatchLine[] = [];                 // lignes en base, tenues à jour localement après chaque enregistrement
  let sortCol: Col = 'circuit', dir: 1 | -1 = 1;
  let order: string[] = [];                    // ordre d'affichage : ne bouge pas pendant la saisie, seulement au clic sur un en-tête
  let queue: Promise<void> = Promise.resolve();   // enregistrements l'un après l'autre (pas de doublon de ligne)
  let busy = 0, stat = '', statErr = false;

  const seed = () => { lines = view().patchLines.filter((l) => l.show_id === showId).map((l) => ({ ...l })); };
  const rowsNow = (): PatchRow[] => buildRows(view(), showId, lines);
  const resort = () => { order = sortRows(rowsNow(), sortCol, dir).map((r) => r.key); };
  const ordered = (): PatchRow[] => {   // lignes dans l'ordre mémorisé ; les nouvelles viennent à la fin
    const rows = rowsNow(), by = new Map(rows.map((r) => [r.key, r]));
    const known = order.filter((k) => by.has(k)).map((k) => by.get(k)!);
    const extra = rows.filter((r) => !order.includes(r.key));
    return [...known, ...sortRows(extra, sortCol, dir)];
  };


  /** Cellule ID modifiable : liste des ID du spectacle + noID + newID, et la double flèche ⇄ pour remplacer le projecteur. */
  const idCell = (r: PatchRow): string => {
    const d = view(), ids = d.showItems.filter((s) => s.show_id === showId).map((s) => s.item_id).sort((a, b) => a - b);
    const modelOf = (n: number) => { const it = d.items.find((i) => i.id === n); return it ? describe(d, it).model?.name ?? '' : ''; };
    // Ligne d'un projecteur : noID, « ajouter du stock » (avec recherche), puis les ID du spectacle.
    // Ligne sans projecteur : noID, ou directement les ID des projecteurs du stock disponibles à ces dates et pas encore affectés.
    const own = ids.map((n) => `<option value="${n}" ${n === r.itemId ? 'selected' : ''}>${n === r.itemId ? n : `${n} · ${esc(modelOf(n))}`}</option>`).join('');
    // Ligne sans projecteur : suggestions classées (même modèle, modèles similaires, autres), avec la raison du classement.
    const sug = r.itemId !== null ? [] : suggest(r), grp = (g: Suggestion['group'], t: string) => {
      const l = sug.filter((x) => x.group === g); return l.length ? `<optgroup label="${t}">${l.map((x) => `<option value="stock:${x.id}">${esc(sugLabel(x, false))}</option>`).join('')}</optgroup>` : '';
    };
    const stock = r.modelId ? grp('same', 'Suggestions (même modèle)') + grp('similar', 'Modèles similaires') + grp('other', 'Autres modèles') : grp('other', 'Projecteurs disponibles');
    return `<span class="idcell"><select class="pin idsel" data-k="id" style="--w:${wch(r.itemId === null ? 'noID' : String(r.itemId), 4)}ch" aria-label="ID du projecteur (ou noID, ou un projecteur du stock)">
      <option value="noid" ${r.itemId === null ? 'selected' : ''}>noID</option><option value="scan">Scanner un QR code…</option>${r.itemId === null ? stock : `<option value="new">Ajouter un projecteur du stock…</option>${own}`}</select>
      ${r.itemId !== null ? `<a class="idlink" href="#/item/${r.itemId}?from=patch-${esc(showId)}" aria-label="Voir la fiche du projecteur ${r.itemId}">↗</a><button class="btn mini swapbtn" data-act="swap" title="Remplacer ce projecteur par un autre du stock" aria-label="Remplacer le projecteur ${r.itemId} par un autre">⇄</button>` : ''}</span>`;
  };
  /** Ce que demande une ligne : son modèle, sa lampe (PAR) et sa position. */
  const suggest = (r: PatchRow): Suggestion[] => {
    const d = view(), show = d.shows.find((s) => s.id === showId); if (!show) return [];
    return rankStock(d, show, { modelId: r.modelId, lampId: r.lampId, par: r.par, position: r.position });
  };
  /** Texte d'une suggestion : « 123 · Modèle · raisons du classement ». */
  const sugLabel = (x: Suggestion, withN: boolean): string => `${withN ? 'n° ' : ''}${x.id} · ${x.model}${x.group === 'similar' ? ' (similaire)' : ''} · ${x.reasons.join(' · ')}`;
  /** Projecteurs qu'on peut ajouter dans une fenêtre de choix, classés pour la ligne r (ou sans critère si null). */
  const candidates = (r: PatchRow | null): [string, string][] => {
    const d = view(), show = d.shows.find((s) => s.id === showId); if (!show) return [];
    const list = r ? suggest(r) : rankStock(d, show, { modelId: null, lampId: null, par: false, position: '' });
    return list.map((x): [string, string] => [String(x.id), sugLabel(x, true)]);
  };
  /** Avertissement bien visible si le projecteur choisi n'est pas du modèle de la ligne (même « similaire »). Renvoie true si on continue : c'est autorisé, mais il faut le confirmer. */
  const warnModel = async (r: PatchRow, n: number): Promise<boolean> => {
    const d = view(), it = d.items.find((i) => i.id === n);
    if (!r.modelId || !it || it.model_id === r.modelId) return true;       // pas de modèle prévu, ou même modèle : rien à signaler
    const have = d.models.find((m) => m.id === it.model_id)?.name ?? '?', want = d.models.find((m) => m.id === r.modelId)?.name ?? r.model;
    const sim = similarNames(want, have);
    navigator.vibrate?.([120, 60, 120]);                                    // petit signal sur téléphone
    const c = await ask('⚠ MODÈLE DIFFÉRENT', `La ligne prévoit un ${want}, mais le projecteur ${n} est un ${have}${sim ? ' (modèle similaire)' : ''}.`, [['ok', 'Utiliser quand même', true]], true);
    return c === 'ok';
  };
  /** Réponse à un QR code lu dans une fenêtre de choix : accepte un projecteur de la liste, sinon explique pourquoi pas. */
  const scanReply = (opts: [string, string][]) => (text: string): { value: string } | { error: string } => {
    const n = parseScan(text); if (n === null) return { error: `QR non reconnu : « ${text.slice(0, 40)} »` };
    if (opts.some(([v]) => v === String(n))) return { value: String(n) };
    const d = view(), show = d.shows.find((x) => x.id === showId);
    if (!d.items.some((i) => i.id === n)) return { error: `Projecteur n° ${n} introuvable dans la base.` };
    return { error: `Le n° ${n} n'est pas disponible : ${(show && blockedReason(d, n, show)) || 'indisponible'}.` };
  };
  /** Lampe à demander pour un PAR : celle voulue par la ligne si elle en a une, sinon celle qui est montée sur le projecteur choisi. */
  const lampFor = (n: number, r?: PatchRow): string | null => { const d = view(), it = d.items.find((i) => i.id === n); return it && /^PAR/i.test(describe(d, it).type?.name ?? '') ? (r?.itemId === null && r.lampId ? r.lampId : it.lamp_id) : null; };
  /** Petite fenêtre à plusieurs boutons : renvoie la valeur du bouton touché, ou null. */
  const ask = (title: string, text: string, buttons: [string, string, boolean?][], danger = false): Promise<string | null> => new Promise((resolve) => {
    const dlg = document.createElement('dialog'); dlg.className = 'dlg' + (danger ? ' danger' : '');   // danger : cadre rouge, bien visible
    dlg.innerHTML = `<form method="dialog" class="stack"><h2>${esc(title)}</h2><div>${esc(text)}</div>
      <div class="stack">${buttons.map(([v, l, primary]) => `<button class="btn${primary ? ' primary' : ''}" value="${esc(v)}">${esc(l)}</button>`).join('')}<button class="btn" value="">Annuler</button></div></form>`;
    document.body.appendChild(dlg);
    const fin = (v: string | null) => { dlg.close(); dlg.remove(); resolve(v || null); };
    dlg.querySelector('form')!.addEventListener('submit', (e) => { e.preventDefault(); fin(((e as SubmitEvent).submitter as HTMLButtonElement | null)?.value ?? null); });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); fin(null); });
    dlg.showModal(); dlg.querySelector<HTMLElement>('h2')!.tabIndex = -1; dlg.querySelector<HTMLElement>('h2')!.focus();   // le focus va sur le titre, pas sur un bouton
  });

  /** Appel serveur qui change la structure de la feuille (ID, lignes, gélatines) : recharge, remet en ordre, redessine. */
  async function structural(root: HTMLElement, fn: string, params: Record<string, unknown>, okMsg: string): Promise<boolean> {
    busy++; setStat(root, 'Enregistrement…');
    await queue.catch(() => {});                       // on attend les saisies en cours
    const r = await rpcCall(fn, { p_show: showId, ...params });
    busy--;
    seed();
    if (r.error) { setStat(root, r.error, true); toast(r.error); resort(); paint(root); return false; }
    setStat(root, okMsg + ' ✓ ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
    resort(); paint(root); return true;
  }
  /** Gestes de la cellule ID et des boutons de ligne. */
  async function act(root: HTMLElement, key: string, what: string, v?: string) {
    const r = rowsNow().find((x) => x.key === key); if (!r) return;
    const who = { p_item: r.itemId, p_line: r.itemId === null ? r.lineId : null };
    if (what === 'id') {
      if (v === 'noid') { if (r.itemId !== null) await structural(root, 'patch_set_item', { ...who, p_mode: 'noid' }, 'Ligne sans projecteur'); return; }
      if (v === 'scan') {   // scan d'un QR code : projecteur déjà affecté = échange de lignes ; projecteur du stock disponible = ajout
        const inShow = new Set(view().showItems.filter((x) => x.show_id === showId).map((x) => x.item_id));
        const mine = [...inShow].filter((n) => n !== r.itemId).sort((a, b) => a - b).map((n): [string, string] => [String(n), `n° ${n} · déjà dans ce spectacle`]);
        const opts = [...mine, ...candidates(r)];
        const p = openForm('Scanner un projecteur', [{ name: 'to', label: 'Projecteur', type: 'select', search: true, required: true, options: opts, scan: scanReply(opts), hint: 'Un projecteur déjà dans le spectacle prend la place de celui de la ligne ; un projecteur du stock est ajouté au spectacle.' }], { submit: 'Valider' });
        setTimeout(() => document.querySelector<HTMLElement>('dialog.dlg [data-scan]')?.click(), 150);   // la caméra démarre tout de suite
        const f = await p;
        if (!f) { paintRow(root, key); return; }
        const n = Number(f.to);
        if (!(await warnModel(r, n))) { paintRow(root, key); return; }          // modèle différent : on demande confirmation
        if (inShow.has(n)) await structural(root, 'patch_set_item', { ...who, p_mode: 'choose', p_target: n }, `Projecteur ${n} placé`);
        else await structural(root, 'patch_set_item', { ...who, p_mode: 'new', p_target: n, p_lamp: lampFor(n, r) }, `Projecteur ${n} ajouté`);
        return;
      }
      if (v?.startsWith('stock:')) {   // ID choisi directement dans la liste du stock disponible
        const n = Number(v.slice(6));
        if (!(await warnModel(r, n))) { paintRow(root, key); return; }
        await structural(root, 'patch_set_item', { ...who, p_mode: 'new', p_target: n, p_lamp: lampFor(n, r) }, `Projecteur ${n} ajouté`); return;
      }
      if (v === 'new') {
        const f = await openForm('Ajouter un projecteur au spectacle', [{ name: 'to', label: 'Projecteur', type: 'select', search: true, required: true, options: candidates(r), hint: 'Seuls les projecteurs disponibles à ces dates sont proposés.' }], { submit: 'Ajouter' });
        if (!f) { paintRow(root, key); return; }
        const n = Number(f.to);
        if (!(await warnModel(r, n))) { paintRow(root, key); return; }
        await structural(root, 'patch_set_item', { ...who, p_mode: 'new', p_target: n, p_lamp: lampFor(n, r) }, `Projecteur ${n} ajouté`); return;
      }
      const n = Number(v);
      if (!(await warnModel(r, n))) { paintRow(root, key); return; }
      await structural(root, 'patch_set_item', { ...who, p_mode: 'choose', p_target: n }, `Projecteur ${n} placé`); return;
    }
    if (what === 'swap' && r.itemId !== null) {
      const old = r.itemId, opts = candidates(r);
      if (!opts.length) { toast('Aucun projecteur du stock n\'est disponible pendant ce spectacle.'); return; }
      const f = await openForm(`Remplacer le projecteur ${old}`, [
        { name: 'to', label: 'Par le projecteur', type: 'select', search: true, required: true, options: opts, scan: scanReply(opts), hint: r.auto ? 'Ce projecteur vient d\'une demande : choisis le même modèle.' : 'Le projecteur remplacé est retiré du spectacle ; circuit, gélatines, etc. restent sur la ligne.' },
        { name: 'fault', label: `Déclarer une panne sur le projecteur ${old} ?`, type: 'select', options: [['', 'Non'], ['oui', 'Oui, en même temps']], value: '' },
        { name: 'desc', label: 'Description de la panne (si oui)', type: 'textarea' }], { submit: 'Remplacer' });
      if (!f) return;
      const n = Number(f.to);
      if (!(await warnModel(r, n))) { paintRow(root, key); return; }
      const ok = await structural(root, 'patch_set_item', { ...who, p_mode: 'replace', p_target: n, p_lamp: lampFor(n, r) }, `Projecteur ${old} remplacé par ${n}`);
      if (ok && f.fault === 'oui') {
        await reportFault(old, f.desc || `Remplacé dans la feuille de patch (${view().shows.find((s) => s.id === showId)?.name ?? ''})`);
        toast(`Panne déclarée sur le projecteur ${old}.`, 'ok');
      }
      return;
    }
    if (what === 'line-del') {
      if (r.itemId === null) { if (window.confirm('Supprimer cette ligne ?')) await structural(root, 'patch_delete_line', { p_item: null, p_line: r.lineId, p_remove: false }, 'Ligne supprimée'); return; }
      const buttons: [string, string, boolean?][] = [['keep', 'Garder le projecteur affecté (vider la ligne)', true]];
      if (!r.auto) buttons.push(['remove', 'Retirer aussi le projecteur des projecteurs affectés']);
      const c = await ask(`Supprimer la ligne du projecteur ${r.itemId} ?`, r.auto ? 'Ce projecteur vient d\'une demande de matériel : il reste affecté.' : 'Retirer aussi le projecteur des projecteurs affectés ?', buttons);
      if (c) await structural(root, 'patch_delete_line', { p_item: r.itemId, p_line: null, p_remove: c === 'remove' }, c === 'remove' ? 'Projecteur retiré' : 'Ligne vidée');
      return;
    }
    if (what === 'gel-add') {
      const used = [...new Set(view().showGels.filter((g) => g.show_id === showId).map((g) => g.ref))].sort();
      const f = await openForm(r.itemId === null ? 'Gel sur cette ligne' : `Gel sur le projecteur ${r.itemId}`, [{ name: 'ref', label: 'Référence du gel', required: true, hint: used.length ? `Déjà utilisés ici : ${used.join(', ')}` : 'Ex. L201 (Lee), R80 ou #80 (Rosco)' }], { submit: 'Ajouter le gel' });
      if (!f) return;
      if (r.itemId === null) await structural(root, 'patch_add_line_gel', { p_line: r.lineId, p_ref: f.ref.trim(), p_color: gelColorOf(f.ref) }, `Gel ${f.ref.trim()} ajouté`);   // ligne sans projecteur
      else await structural(root, 'patch_add_gel', { p_item: r.itemId, p_ref: f.ref.trim(), p_color: gelColorOf(f.ref) }, `Gel ${f.ref.trim()} ajouté`);
      return;
    }
    if (what === 'gel-del' && v) {
      if (r.itemId === null) await structural(root, 'patch_delete_line_gel', { p_line: r.lineId, p_ref: v }, 'Gel retiré');
      else await structural(root, 'patch_delete_gel', { p_id: v }, 'Gel retiré');
      return;
    }
  }

  /** Cellule modèle d'une ligne sans projecteur : modèle du catalogue (groupé par type), texte libre, ajout au catalogue (régisseur général / admin) et lampe pour un PAR. */
  const modelCell = (r: PatchRow): string => {
    const d = view(), types = [...d.types].sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    const groups = [...types.map((t) => ({ label: t.name, id: t.id as string | null })), { label: 'Sans type', id: null }].map((g) => {
      const ms = d.models.filter((m) => (m.type_id ?? null) === g.id).sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
      return ms.length ? `<optgroup label="${esc(g.label)}">${ms.map((m) => `<option value="${esc(m.id)}" ${m.id === r.modelId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>` : '';
    }).join('');
    const free = !r.modelId && r.model ? `<option value="__keep" selected>${esc(r.model)} (texte libre)</option>` : '';
    const sel = `<select class="pin" data-k="model_pick" aria-label="Modèle du projecteur"><option value="" ${!r.modelId && !r.model ? 'selected' : ''}>—</option>${free}${groups}<option value="__text">Autre (texte libre)…</option>${can('regisseur_general') ? '<option value="__add">+ Ajouter un modèle au catalogue…</option>' : ''}</select>`;
    if (!r.par) return sel;
    const model = d.models.find((m) => m.id === r.modelId);
    const lamps = d.lamps.filter((l) => !model?.socket_id || !l.socket_id || l.socket_id === model.socket_id).sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    return `${sel}<select class="pin" data-k="lamp_pick" aria-label="Lampe du PAR"><option value="">Lampe ?</option>${lamps.map((l) => `<option value="${esc(l.id)}" ${l.id === r.lampId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>`;
  };
  /** Largeur (en caractères) d'une cellule étroite : celle de son contenu, avec un minimum. */
  const wch = (v: string, min = 3): number => Math.max(min, v.length + 1);
  const cell = (r: PatchRow, c: Col, ed: Set<Col>): string => {
    const can_ = ed.has(c);
    switch (c) {
      case 'circuit': case 'dimmer': return can_ ? `<input class="pin num" data-k="${c}" style="--w:${wch(r[c])}ch" value="${esc(r[c])}" maxlength="30" autocomplete="off" aria-label="${c === 'circuit' ? 'Circuit' : 'Grada'}">` : `<span class="num">${esc(r[c]) || '<i class="muted">—</i>'}</span>`;
      case 'curve': {   // un seul choix possible
        const v = r.curve[0] ?? 'lineaire';
        if (!can_) return v === 'direct' ? '<b class="direct">DIRECT</b>' : `<span>${esc(labelsOf(CURVES, r.curve)) || '<i class="muted">—</i>'}</span>`;
        return `<select class="pin${v === 'direct' ? ' direct' : ''}" data-k="curve" aria-label="Courbe">${CURVES.map((x) => `<option value="${x.k}" ${x.k === v ? 'selected' : ''}>${x.k === 'direct' ? 'DIRECT' : esc(x.label)}</option>`).join('')}</select>`;
      }
      case 'accessories': {
        const list = ACCESSORIES, vals = r.accessories, txt = esc(labelsOf(list, vals));
        if (!can_) return `<span>${txt || '<i class="muted">—</i>'}</span>`;
        return `<details class="multi" data-k="accessories"><summary>${txt || '<i class="muted">—</i>'}</summary><div class="opts">${list.map((x) =>
          `<label><input type="checkbox" data-v="${x.k}" ${vals.includes(x.k) ? 'checked' : ''}> ${esc(x.label)}</label>`).join('')}</div></details>`;
      }
      case 'dmx': return can_ && r.curve.includes('direct') ? `<input class="pin num" data-k="dmx" style="--w:${wch(r.dmx, 5)}ch" value="${esc(r.dmx)}" placeholder="1-120" maxlength="7" inputmode="numeric" autocomplete="off" aria-label="Adresse DMX, univers-adresse">`
        : r.curve.includes('direct') ? `<span class="num">${esc(r.dmx) || '<i class="muted">—</i>'}</span>` : '<i class="muted">—</i>';
      case 'id': return can_ ? idCell(r) : r.itemId === null ? '<span class="muted">N/C</span>' : `<a class="num idlink" href="#/item/${r.itemId}?from=patch-${esc(showId)}">${r.itemId}</a>`;
      case 'model': return r.itemId === null && can_ ? modelCell(r) : `<span>${esc(r.model) || '<i class="muted">—</i>'}</span>`;
      case 'gels': {
        const chips = r.gels.map((g, i) => `<span class="gel"><i style="background:${gelCss(gelColorOf(g))}"></i>${esc(g)}${can_ && r.gelIds[i] ? `<button class="gx" data-act="gel-del" data-v="${esc(r.gelIds[i])}" aria-label="Retirer le gel ${esc(g)}">✕</button>` : ''}</span>`).join(' ');
        const add = can_ ? `<button class="btn mini" data-act="gel-add" aria-label="Ajouter un gel">+ Gel</button>` : '';
        return chips || add ? `<span class="gels">${chips}${add}</span>` : '<i class="muted">—</i>';
      }
      case 'position': return can_ ? `<select class="pin" data-k="position" aria-label="Position"><option value="">—</option>${POSITIONS.map((p) => `<option ${p === r.position ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>` : `<span>${esc(r.position) || '<i class="muted">—</i>'}</span>`;
      case 'focus': return `<input type="checkbox" class="fcb" data-k="focus" ${r.focus ? 'checked' : ''} ${can_ ? '' : 'disabled'} aria-label="Focus fait">`;
      case 'notes': return can_ ? `<input class="pin" data-k="notes" value="${esc(r.notes)}" maxlength="500" autocomplete="off" aria-label="Notes">` : `<span>${esc(r.notes) || '<i class="muted">—</i>'}</span>`;
    }
  };
  const rowHtml = (r: PatchRow, ed: Set<Col>): string => `<tr data-key="${esc(r.key)}" class="${r.focus ? 'done' : ''}" ${r.updatedAt ? `title="Modifié ${esc(fmtDateTime(r.updatedAt))}${r.updatedBy ? ' par ' + esc(r.updatedBy) : ''}"` : ''}>${COLS.map((c) => `<td data-label="${c.label}" data-c="${c.k}">${cell(r, c.k, ed)}</td>`).join('')}<td class="rowact" data-c="act">${ed.has('id') ? `<button class="btn mini" data-act="line-del" aria-label="Supprimer la ligne">Suppr.</button>` : ''}</td></tr>`;

  /** Choix du modèle d'une ligne sans projecteur : catalogue, texte libre, ou nouveau modèle ajouté au catalogue. */
  async function pickModel(root: HTMLElement, key: string, v: string) {
    if (v === '__keep') return;                                   // texte libre déjà en place : rien à faire
    if (v === '') { save(root, key, 'model_id', ''); save(root, key, 'model_text', ''); queue = queue.then(() => paintRow(root, key)); return; }
    if (v === '__text') {
      const f = await openForm('Modèle en texte libre', [{ name: 't', label: 'Nom du modèle', required: true }], { submit: 'Valider' });
      if (!f) { paintRow(root, key); return; }
      save(root, key, 'model_text', f.t.trim()); queue = queue.then(() => paintRow(root, key)); return;
    }
    if (v === '__add') {
      const types = [...view().types].sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
      const f = await openForm('Ajouter un modèle au catalogue', [
        { name: 'n', label: 'Nom du modèle', required: true, hint: 'Il rejoint le catalogue du stock : tout le monde pourra le choisir.' },
        { name: 't', label: 'Type', type: 'select', options: [['', 'Sans type'], ...types.map((t): [string, string] => [t.id, t.name])] }], { submit: 'Ajouter' });
      if (!f) { paintRow(root, key); return; }
      const r = await rpcCall('add_model', { p_name: f.n.trim(), p_type: f.t || null });
      if (r.error || !r.data) { toast(r.error ?? 'Ajout impossible'); paintRow(root, key); return; }
      toast(`Modèle « ${f.n.trim()} » ajouté au catalogue.`, 'ok');
      save(root, key, 'model_id', String(r.data)); queue = queue.then(() => paintRow(root, key)); return;
    }
    save(root, key, 'model_id', v); queue = queue.then(() => paintRow(root, key));   // modèle du catalogue : on redessine (la lampe n'apparaît que pour un PAR)
  }

  const edSet = () => (navigator.onLine ? editableCols(canActShow(showId), can('technicien')) : new Set<Col>());

  function paint(root: HTMLElement) {
    const show = view().shows.find((s) => s.id === showId);
    const host = root.querySelector('#phost')!;
    if (!show) { host.innerHTML = '<div class="card empty">Spectacle introuvable.<br><a href="#/shows">Retour aux spectacles</a></div>'; return; }
    const ed = edSet(), rows = ordered();
    const last = rows.filter((r) => r.updatedAt).sort((a, b) => b.updatedAt!.localeCompare(a.updatedAt!))[0];
    const arrow = (c: Col) => (sortCol === c ? (dir === 1 ? ' ▲' : ' ▼') : '');
    host.innerHTML = `<div class="phead"><a href="#/show/${esc(showId)}" class="sub">‹ ${esc(show.name)}</a>
      <div class="row wrap"><h1 class="grow">Patch / Focus</h1><span id="pstat" class="sub ${statErr ? 'warn' : ''}" role="status">${esc(stat)}</span></div>
      <div class="sub">${esc(show.name)} · du ${fmtDay(show.start_date)} au ${fmtDay(show.end_date)} · ${rows.length} ligne${rows.length > 1 ? 's' : ''} · focus ${rows.filter((r) => r.focus).length}/${rows.length}${last ? ` · dernière modification ${esc(fmtDateTime(last.updatedAt!))}${last.updatedBy ? ' par ' + esc(last.updatedBy) : ''}` : ''}</div>
      ${!navigator.onLine ? '<div class="banner">Hors ligne : la feuille est en lecture seule.</div>' : ed.size === 0 ? '<div class="sub">Consultation seulement : tu n\'es pas assigné à ce spectacle.</div>'
        : !canActShow(showId) ? '<div class="sub">Tu peux modifier la grada, la courbe et les gélatines.</div>' : ''}
      <div class="row wrap noprint">${ed.has('id') ? '<button class="btn primary" data-act="line-add">+ Ajouter une ligne</button>' : ''}<button class="btn" data-act="pdf">PDF</button></div></div>
      <div class="row patch-sortbar"><label class="f grow">Trier par<select id="psort">${COLS.map((c) => `<option value="${c.k}" ${c.k === sortCol ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
        <button class="btn" data-act="pdir" aria-label="Inverser le tri">${dir === 1 ? '▲' : '▼'}</button></div>
      <div class="ptable"><table class="patch"><thead><tr>${COLS.map((c) => `<th scope="col" data-c="${c.k}" aria-sort="${sortCol === c.k ? (dir === 1 ? 'ascending' : 'descending') : 'none'}"><button data-sort="${c.k}">${c.label}${arrow(c.k)}</button></th>`).join('')}<th scope="col" class="rowact"><span class="sr">Actions</span></th></tr></thead>
        <tbody>${rows.map((r) => rowHtml(r, ed)).join('') || '<tr><td colspan="12" class="empty">Aucun projecteur affecté à ce spectacle.</td></tr>'}</tbody></table></div>`;
    fitTable(root);
  }
  /** Toujours en tableau (ordinateur et téléphone) : l'en-tête (titre, boutons, titres de colonnes) reste en place, seules les lignes défilent dans le tableau. */
  const fitTable = (root: HTMLElement) => {
    const el = root.querySelector<HTMLElement>('.ptable'); if (!el) return;
    window.scrollTo(0, 0);                                                   // la page elle-même ne défile pas
    const nav = document.querySelector<HTMLElement>('nav.tabs')?.offsetHeight ?? 0;
    el.style.maxHeight = Math.max(120, window.innerHeight - el.getBoundingClientRect().top - nav - 2) + 'px';   // place restante sous l'en-tête, au-dessus de la barre du bas
  };
  /** Redessine une seule ligne (changement de courbe : la colonne DMX s'active / se vide ; ou erreur : retour à la valeur enregistrée). */
  function paintRow(root: HTMLElement, key: string) {
    const r = rowsNow().find((x) => x.key === key), tr = [...root.querySelectorAll<HTMLElement>('tbody tr')].find((x) => x.dataset.key === key);
    if (r && tr) tr.outerHTML = rowHtml(r, edSet());
  }
  const setStat = (root: HTMLElement, t: string, err = false) => { stat = t; statErr = err; const e = root.querySelector('#pstat'); if (e) { e.textContent = t; e.className = 'sub' + (err ? ' warn' : ''); } };

  /** Envoie un champ au serveur (les envois se suivent) puis met la ligne locale à jour. */
  function save(root: HTMLElement, key: string, field: string, value: unknown) {
    const r = rowsNow().find((x) => x.key === key); if (!r) return;
    busy++; setStat(root, 'Enregistrement…');
    queue = queue.then(async () => {
      const cur = rowsNow().find((x) => x.key === key) ?? r;   // l'ID de ligne a pu être créé par un envoi précédent
      const { data, error } = await supabase.rpc('set_patch_field', { p_show: showId, p_item: cur.itemId, p_line: cur.lineId, p_field: field, p_value: value });
      busy--;
      if (error || !data) { setStat(root, error?.message ?? 'Enregistrement impossible', true); paintRow(root, key); return; }
      const line = data as PatchLine; const i = lines.findIndex((l) => l.id === line.id);
      if (i >= 0) lines[i] = line; else lines.push(line);
      setStat(root, 'Enregistré ✓ ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
      if (field === 'curve') paintRow(root, key);   // DMX actif seulement avec DIRECT
    });
  }

  return {
    mount(root) {
      seed();
      root.innerHTML = '<div class="page patch-page"><div id="phost"></div></div>';
      resort(); paint(root);
      root.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        const b = t.closest<HTMLElement>('[data-sort]');
        if (b) { const c = b.dataset.sort as Col; if (sortCol === c) dir = dir === 1 ? -1 : 1; else { sortCol = c; dir = 1; } resort(); paint(root); return; }
        if (t.closest('[data-act="pdir"]')) { dir = dir === 1 ? -1 : 1; resort(); paint(root); return; }
        if (t.closest('[data-act="line-add"]')) {
          void (async () => {
            busy++; setStat(root, 'Enregistrement…');
            const r = await rpcCall('patch_add_line', { p_show: showId }); busy--; seed();
            if (r.error) { setStat(root, r.error, true); toast(r.error); return; }
            setStat(root, 'Ligne ajoutée ✓'); paint(root);
            const id = (r.data as PatchLine | null)?.id;   // la nouvelle ligne est en bas : on la montre et on se place sur son circuit
            const tr = [...root.querySelectorAll<HTMLElement>('tbody tr')].find((x) => x.dataset.key === `l${id}`);
            tr?.scrollIntoView({ block: 'center' }); tr?.querySelector<HTMLInputElement>('input.pin')?.focus({ preventScroll: true });
          })();
          return;
        }
        if (t.closest('[data-act="pdf"]')) {   // PDF horodaté, dans l'ordre affiché à l'écran
          void (async () => {
            try {
              const { buildPatchPdf } = await import('../patchPdf'); const { deliverPdf } = await import('../ui/deliverPdf');
              const { blob, filename } = await buildPatchPdf(view(), showId, ordered());
              await deliverPdf(blob, filename, 'Feuille de patch prête');
            } catch (e) { toast('Impossible de générer le PDF : ' + String(e)); }
          })();
          return;
        }
        const ab = t.closest<HTMLElement>('[data-act]'), tr = t.closest<HTMLElement>('tr[data-key]');
        if (ab && tr && ['swap', 'line-del', 'gel-add', 'gel-del'].includes(ab.dataset.act ?? '')) void act(root, tr.dataset.key!, ab.dataset.act!, ab.dataset.v);
      });
      root.addEventListener('input', (e) => {   // la colonne s'élargit / se resserre pendant la frappe
        const t = e.target as HTMLInputElement; if (t.tagName === 'INPUT' && t.classList.contains('num')) t.style.setProperty('--w', Math.max(t.dataset.k === 'dmx' ? 5 : 3, t.value.length + 1) + 'ch');
      });
      root.addEventListener('change', (e) => {
        const t = e.target as HTMLInputElement | HTMLSelectElement;
        if (t.id === 'psort') { sortCol = t.value as Col; dir = 1; resort(); paint(root); return; }
        const tr = t.closest<HTMLElement>('tr[data-key]'); if (!tr) return;
        const key = tr.dataset.key!;
        const multi = t.closest<HTMLElement>('details.multi');
        if (multi) { save(root, key, multi.dataset.k!, [...multi.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map((x) => x.dataset.v!)); return; }
        const k = (t as HTMLElement).dataset.k; if (!k) return;
        if (k === 'curve') { save(root, key, 'curve', [t.value]); return; }   // courbe : un seul choix
        if (k === 'id') { void act(root, key, 'id', t.value); return; }
        if (k === 'model_pick') { void pickModel(root, key, t.value); return; }   // modèle d'une ligne sans projecteur
        if (k === 'lamp_pick') { save(root, key, 'lamp_id', t.value); return; }   // cellule ID : changement de projecteur
        save(root, key, k, k === 'focus' ? (t as HTMLInputElement).checked : t.value.trim());
        if (k === 'focus') tr.classList.toggle('done', (t as HTMLInputElement).checked);
      });
      // menu des accessoires : posé en « fixed » sous la case (ou au-dessus s'il manque de place), pour ne pas être coupé par la zone de défilement du tableau
      root.addEventListener('toggle', (e) => {
        const d = e.target as HTMLDetailsElement; if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('multi') || !d.open) return;
        const box = d.querySelector<HTMLElement>('.opts'), sm = d.querySelector('summary'); if (!box || !sm) return;
        const r = sm.getBoundingClientRect();
        box.style.position = 'fixed'; box.style.left = Math.max(4, Math.min(r.left, window.innerWidth - box.offsetWidth - 4)) + 'px';
        box.style.top = (r.bottom + box.offsetHeight + 4 > window.innerHeight ? Math.max(4, r.top - box.offsetHeight) : r.bottom) + 'px';   // en haut si le bas de l'écran est trop proche
      }, true);
      root.addEventListener('scroll', () => root.querySelectorAll<HTMLDetailsElement>('details.multi[open]').forEach((d) => { d.open = false; }), true);   // défiler ferme le menu (sa place ne suivrait plus)
      // un menu à cases se ferme quand on touche ailleurs
      const repaint = () => paint(root);
      document.addEventListener('click', closeMenus);
      const refit = () => fitTable(root);   // rotation ou redimensionnement
      window.addEventListener('resize', refit); window.addEventListener('orientationchange', refit);
      window.addEventListener('online', repaint); window.addEventListener('offline', repaint);
      return () => { document.removeEventListener('click', closeMenus); window.removeEventListener('resize', refit); window.removeEventListener('orientationchange', refit); window.removeEventListener('online', repaint); window.removeEventListener('offline', repaint); };   // nettoyage à la sortie de la page
    },
    update(root) {
      if (busy || root.querySelector('.patch :focus, details.multi[open]')) return;   // jamais pendant une saisie
      seed(); paint(root);
    }
  };
};

function closeMenus(e: MouseEvent) {
  document.querySelectorAll<HTMLDetailsElement>('details.multi[open]').forEach((d) => { if (!d.contains(e.target as Node)) d.open = false; });
}
