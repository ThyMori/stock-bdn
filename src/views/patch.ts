import type { ViewFactory } from '../router';
import { can, canActShow, reportFaultSav, rpcCall, upsertPatchLine, view } from '../store';
import { supabase } from '../supabase';
import { esc, fmtDateTime, parseScan } from '../logic';
import { gelCss } from '../types';
import { gelColorOf, splitGelRefs } from '../gels';
import { ACCESSORIES, COLS, CURVES, POSITION_GROUPS, buildRows, editableCols, extCount, externalStatus, labelsOf, sortRows, stateText } from '../patch';
import type { Col, PatchLine, PatchRow } from '../patch';
import { fmtDay } from './agenda';
import { openForm, confirmBox } from '../ui/dialog';
import { toast } from '../ui/toast';
import { blockedReason } from '../alerts';
import { describe } from '../ref';
import { rankStock, similarNames } from '../patchSuggest';
import { clampW, colCss, loadWidths, saveWidths } from '../patchCols';
import type { Widths } from '../patchCols';
import { batchActions, batchTargets, lignes, rangeKeys } from '../patchBatch';
import type { BatchAction } from '../patchBatch';
import type { Suggestion } from '../patchSuggest';

/** Feuille de patch / focus d'un spectacle : une ligne par projecteur affecté, saisie directe, tri par colonne. */
export const patchView: ViewFactory = ([showId]) => {
  let lines: PatchLine[] = [];                 // lignes en base, tenues à jour localement après chaque enregistrement
  let sortCol: Col = 'circuit', dir: 1 | -1 = 1;
  let order: string[] = [];                    // ordre d'affichage : ne bouge pas pendant la saisie, seulement au clic sur un en-tête
  let queue: Promise<void> = Promise.resolve();   // enregistrements l'un après l'autre (pas de doublon de ligne)
  let busy = 0, stat = '', statErr = false;
  let selMode = false, lastSel: string | null = null;   // mode « Sélectionner » : lignes cochées (clés), dernière case touchée (pour Maj + clic)
  const sel = new Set<string>();

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
  /** Garde : un projecteur indisponible pendant le spectacle (autre spectacle, prêt, SAV, panne) est refusé, même s'il est déjà affecté au spectacle. Renvoie true si c'est refusé. */
  const refuseBlocked = async (n: number): Promise<boolean> => {
    const d = view(), show = d.shows.find((x) => x.id === showId), why = show ? blockedReason(d, n, show) : null;
    if (!why) return false;
    navigator.vibrate?.([250, 100, 250, 100, 250]);
    await ask('⛔ PROJECTEUR INDISPONIBLE', `Le projecteur ${n} n'est pas disponible pendant toute la durée du spectacle : ${why}. Il ne peut pas être utilisé ici.`, [], true);
    return true;
  };
  /** Texte d'alerte si le projecteur n'a pas le modèle prévu par la ligne (sinon null). Sert au scan et à la fenêtre de confirmation. */
  const modelGap = (r: PatchRow, n: number): string | null => {
    const d = view(), it = d.items.find((i) => i.id === n);
    if (!r.modelId || !it || it.model_id === r.modelId) return null;
    const have = d.models.find((m) => m.id === it.model_id)?.name ?? '?', want = d.models.find((m) => m.id === r.modelId)?.name ?? r.model;
    return `⚠ MODÈLE DIFFÉRENT : la ligne prévoit un ${want}, le projecteur ${n} est un ${have}${similarNames(want, have) ? ' (modèle similaire)' : ''}.`;
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
    const n = parseScan(text); if (n === null) return { error: `⚠ QR non reconnu : « ${text.slice(0, 40)} »` };
    const d = view(), show = d.shows.find((x) => x.id === showId);
    const why = show && d.items.some((i) => i.id === n) ? blockedReason(d, n, show) : null;   // même un projecteur déjà dans le spectacle peut être devenu indisponible (prêt, SAV, panne…)
    if (why) return { error: `⚠ PROJECTEUR INDISPONIBLE : le n° ${n} n'est pas disponible pendant tout le spectacle (${why}).` };
    if (opts.some(([v]) => v === String(n))) return { value: String(n) };
    if (!d.items.some((i) => i.id === n)) return { error: `⚠ Projecteur n° ${n} introuvable dans la base.` };
    return { error: `⚠ PROJECTEUR INDISPONIBLE : le n° ${n} n'est pas disponible pendant tout le spectacle (${(show && blockedReason(d, n, show)) || 'indisponible'}).` };
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

  /** Modification ou suppression en lot (fonction serveur patch_batch : tout ou rien). Renvoie true si ça a marché. */
  async function batchRun(root: HTMLElement, op: string, value: Record<string, unknown>, okMsg: string): Promise<boolean> {
    const targets = batchTargets(sel);
    if (!targets.length) return false;
    busy++; setStat(root, 'Enregistrement…');
    await queue.catch(() => {});                       // on attend les saisies en cours
    const r = await rpcCall('patch_batch', { p_show: showId, p_targets: targets, p_op: op, p_value: value });
    busy--; seed();
    if (r.error) { setStat(root, r.error, true); toast(r.error); resort(); paint(root); return false; }   // rien n'a été modifié : la sélection reste
    selMode = false; sel.clear(); lastSel = null;     // succès : on quitte la sélection
    setStat(root, `${okMsg} ✓ ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`);
    resort(); paint(root); return true;
  }
  /** « Modifier… » : on choisit l'action, puis sa valeur ; la fenêtre rappelle le nombre de lignes touchées. */
  async function batchEdit(root: HTMLElement) {
    const n = sel.size, n_ = lignes(n);
    const acts = batchActions(canActShow(showId));
    const a = await openForm(`Modifier ${n_}`, [{ name: 'a', label: 'Que veux-tu changer ?', type: 'select', required: true, options: acts }], { submit: 'Suivant', focus: 'a' });
    if (!a) return;
    const act = a.a as BatchAction;
    const accs = ACCESSORIES.map((x): [string, string] => [x.k, x.label]);
    const pos = [['', 'Choisir…'], ...POSITION_GROUPS.flatMap((g) => g.items.map((i): [string, string] => [i, `${g.label} · ${i}`]))] as [string, string][];
    const title = `${acts.find(([k]) => k === act)![1].replace('…', '')} : ${n_}`;
    switch (act) {
      case 'position': { const f = await openForm(title, [{ name: 'v', label: 'Position', type: 'select', required: true, options: pos }], { submit: 'Appliquer' }); if (f && f.v) await batchRun(root, 'field', { field: 'position', value: f.v }, `Position ${f.v} appliquée`); return; }
      case 'curve': { const f = await openForm(title, [{ name: 'v', label: 'Courbe (remplace l\'ancienne)', type: 'select', required: true, options: CURVES.map((c): [string, string] => [c.k, c.label]) }], { submit: 'Appliquer' }); if (f) await batchRun(root, 'field', { field: 'curve', value: [f.v] }, 'Courbe appliquée'); return; }
      case 'acc_add': case 'acc_remove': { const f = await openForm(title, [{ name: 'v', label: 'Accessoire', type: 'select', required: true, options: accs }], { submit: 'Appliquer' }); if (f) await batchRun(root, act, { acc: f.v }, act === 'acc_add' ? 'Accessoire ajouté' : 'Accessoire retiré'); return; }
      case 'gel_add': {
        const f = await openForm(title, [{ name: 'refs', label: 'Référence(s) du gel', required: true, hint: 'Plusieurs possibles : L201 + R119 ou L200, R114. Ex. L201 (Lee), R80 ou #80 (Rosco).' }], { submit: 'Ajouter', focus: 'refs' });
        const refs = f ? splitGelRefs(f.refs) : [];
        if (f && !refs.length) { toast('Indique au moins une référence.'); return; }
        if (f) await batchRun(root, 'gel_add', { gels: refs.map((ref) => ({ ref, color: gelColorOf(ref) })) }, 'Gélatines ajoutées'); return;
      }
      case 'gel_clear': if (await confirmBox(`Vider les gélatines de ${n_} ?`)) await batchRun(root, 'gel_clear', {}, 'Gélatines vidées'); return;
      case 'state': {
        const f = await openForm(title, [{ name: 'v', label: 'État', type: 'select', required: true, options: [['', 'Pas d\'état'], ['ok', 'Focus fait'], ['todo', 'À faire']] }, { name: 'note', label: 'Note (si « À faire »)', type: 'textarea' }], { submit: 'Appliquer' });
        if (f) await batchRun(root, 'field', { field: 'state', value: { s: f.v, note: f.v === 'todo' ? f.note.slice(0, 300) : '' } }, 'État appliqué'); return;
      }
      case 'notes': { const f = await openForm(title, [{ name: 'v', label: 'Note (remplace l\'ancienne ; vide = effacer)', value: '' }], { submit: 'Appliquer' }); if (f) await batchRun(root, 'field', { field: 'notes', value: f.v.slice(0, 500) }, 'Note appliquée'); return; }
      default: {   // vider circuit / grada / DMX
        const fld = act === 'clear_circuit' ? 'circuit' : act === 'clear_dimmer' ? 'dimmer' : 'dmx';
        if (await confirmBox(`Vider ${act === 'clear_circuit' ? 'le circuit' : act === 'clear_dimmer' ? 'la grada' : 'le DMX'} de ${n_} ?`)) await batchRun(root, 'field', { field: fld, value: '' }, 'Champ vidé');
      }
    }
  }
  /** « Supprimer… » : vider les lignes (projecteurs gardés) ou les retirer aussi du spectacle. */
  async function batchDelete(root: HTMLElement) {
    const n_ = lignes(sel.size);
    const c = await ask(`Supprimer ${n_} ?`, 'Les lignes seront vidées (circuit, gélatines, notes…). Tu peux garder les projecteurs affectés au spectacle ou les en retirer. Impossible d\'annuler.', [['keep', 'Vider les lignes, garder les projecteurs affectés', true], ['remove', 'Vider les lignes et retirer les projecteurs du spectacle']], true);
    if (c) await batchRun(root, 'delete', { remove: c === 'remove' }, c === 'remove' ? 'Lignes supprimées, projecteurs retirés' : 'Lignes vidées');
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
        const lead: [string, string][] = [['', 'Choisir un projecteur…'], ...(r.itemId !== null ? [['noid', 'noID (ligne sans projecteur)'] as [string, string]] : [])];   // choix de repli quand on ouvre directement le scan
        const p = openForm('Scanner un projecteur', [{ name: 'to', label: 'Projecteur', type: 'select', search: true, required: true, options: [...lead, ...opts], scan: scanReply(opts), scanWarn: (v) => (v ? modelGap(r, Number(v)) : null), hint: 'Un projecteur déjà dans le spectacle prend la place de celui de la ligne ; un projecteur du stock est ajouté au spectacle.' }], { submit: 'Valider' });
        setTimeout(() => document.querySelector<HTMLElement>('dialog.dlg [data-scan]')?.click(), 150);   // la caméra démarre tout de suite
        const f = await p;
        if (!f) { paintRow(root, key); return; }
        if (f.to === 'noid') { await structural(root, 'patch_set_item', { ...who, p_mode: 'noid' }, 'Ligne sans projecteur'); return; }
        const n = Number(f.to);
        if (await refuseBlocked(n) || !(await warnModel(r, n))) { paintRow(root, key); return; }          // modèle différent : on demande confirmation
        if (inShow.has(n)) await structural(root, 'patch_set_item', { ...who, p_mode: 'choose', p_target: n }, `Projecteur ${n} placé`);
        else await structural(root, 'patch_set_item', { ...who, p_mode: 'new', p_target: n, p_lamp: lampFor(n, r) }, `Projecteur ${n} ajouté`);
        return;
      }
      if (v?.startsWith('stock:')) {   // ID choisi directement dans la liste du stock disponible
        const n = Number(v.slice(6));
        if (await refuseBlocked(n) || !(await warnModel(r, n))) { paintRow(root, key); return; }
        await structural(root, 'patch_set_item', { ...who, p_mode: 'new', p_target: n, p_lamp: lampFor(n, r) }, `Projecteur ${n} ajouté`); return;
      }
      if (v === 'new') {
        const f = await openForm('Ajouter un projecteur au spectacle', [{ name: 'to', label: 'Projecteur', type: 'select', search: true, required: true, options: candidates(r), hint: 'Seuls les projecteurs disponibles à ces dates sont proposés.' }], { submit: 'Ajouter' });
        if (!f) { paintRow(root, key); return; }
        const n = Number(f.to);
        if (await refuseBlocked(n) || !(await warnModel(r, n))) { paintRow(root, key); return; }
        await structural(root, 'patch_set_item', { ...who, p_mode: 'new', p_target: n, p_lamp: lampFor(n, r) }, `Projecteur ${n} ajouté`); return;
      }
      const n = Number(v);
      if (await refuseBlocked(n) || !(await warnModel(r, n))) { paintRow(root, key); return; }
      await structural(root, 'patch_set_item', { ...who, p_mode: 'choose', p_target: n }, `Projecteur ${n} placé`); return;
    }
    if (what === 'swap' && r.itemId !== null) {
      const old = r.itemId, opts = candidates(r);
      if (!opts.length) { toast('Aucun projecteur du stock n\'est disponible pendant ce spectacle.'); return; }
      const f = await openForm(`Remplacer le projecteur ${old}`, [
        { name: 'to', label: 'Par le projecteur', type: 'select', search: true, required: true, options: opts, scan: scanReply(opts), scanWarn: (v) => modelGap(r, Number(v)), hint: 'Le projecteur remplacé est retiré du spectacle ; circuit, gélatines, etc. restent sur la ligne.' },
        { name: 'fault', label: `Déclarer une panne sur le projecteur ${old} ?`, type: 'select', options: [['', 'Non'], ['oui', 'Oui, en même temps']], value: '' },
        { name: 'desc', label: 'Description de la panne (si oui)', type: 'textarea' }], { submit: 'Remplacer' });
      if (!f) return;
      const n = Number(f.to);
      if (await refuseBlocked(n) || !(await warnModel(r, n))) { paintRow(root, key); return; }
      const ok = await structural(root, 'patch_set_item', { ...who, p_mode: 'replace', p_target: n, p_lamp: lampFor(n, r) }, `Projecteur ${old} remplacé par ${n}`);
      if (ok && f.fault === 'oui') {
        await reportFaultSav(old, f.desc || `Remplacé dans la feuille de patch (${view().shows.find((s) => s.id === showId)?.name ?? ''})`);
        toast(`Panne déclarée sur le projecteur ${old}.`, 'ok');
      }
      return;
    }
    if (what === 'line-del') {
      if (r.itemId === null) { if (await confirmBox('Supprimer cette ligne ?')) await structural(root, 'patch_delete_line', { p_item: null, p_line: r.lineId, p_remove: false }, 'Ligne supprimée'); return; }
      const buttons: [string, string, boolean?][] = [['keep', 'Garder le projecteur affecté (vider la ligne)', true]];
      buttons.push(['remove', 'Retirer aussi le projecteur du spectacle']);
      const c = await ask(`Supprimer la ligne du projecteur ${r.itemId} ?`, 'Il peut rester affecté au spectacle, ou être retiré du spectacle (le matériel demandé ne change pas : c\'est un objectif).', buttons);
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
  let skipChange: HTMLElement | null = null;   // champ déjà enregistré par Entrée : son prochain « change » est ignoré
  const extMode = new Set<string>();   // lignes dont on a choisi « Location / prêt » sans avoir encore désigné laquelle
  const modelCell = (r: PatchRow): string => {
    const d = view(), exts = externalStatus(d, showId, lines);   // locations / prêts du spectacle
    const inExt = !!r.externalId || !!r.needId || extMode.has(r.key);            // ligne en mode « Location / prêt » : on ne montre plus le modèle ni la lampe
    const modelId = inExt ? null : r.modelId, types = [...d.types].sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    const groups = [...types.map((t) => ({ label: t.name, id: t.id as string | null })), { label: 'Sans type', id: null }].map((g) => {
      const ms = d.models.filter((m) => (m.type_id ?? null) === g.id).sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
      return ms.length ? `<optgroup label="${esc(g.label)}">${ms.map((m) => `<option value="${esc(m.id)}" ${m.id === modelId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>` : '';
    }).join('');
    const free = !inExt && !r.modelId && r.model ? `<option value="__keep" selected>${esc(r.model)} (texte libre)</option>` : '';
    const sel = `<select class="pin" data-k="model_pick" aria-label="Modèle du projecteur"><option value="" ${!inExt && !r.modelId && !r.model ? 'selected' : ''}>—</option>${exts.length ? `<option value="__ext" ${inExt ? 'selected' : ''}>Location / prêt…</option>` : ''}${free}${groups}<option value="__text">Autre (texte libre)…</option>${can('regisseur_general') ? '<option value="__add">+ Ajouter un modèle au catalogue…</option>' : ''}</select>`;
    const model = d.models.find((m) => m.id === r.modelId);
    const lamps = d.lamps.filter((l) => !model?.socket_id || !l.socket_id || l.socket_id === model.socket_id).sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    const lampSel = r.par ? `<select class="pin" data-k="lamp_pick" aria-label="Lampe du PAR"><option value="">Lampe ?</option>${lamps.map((l) => `<option value="${esc(l.id)}" ${l.id === r.lampId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>` : '';
    const needTxt = r.needId ? `À louer : ${esc(r.model)}` : '';
    const extOpts = exts.map((x) => `<option value="${esc(x.id)}" ${x.id === r.externalId ? 'selected' : ''}>${esc(x.short)} (${x.placed}/${x.qty})</option>`).join('');
    const extSel = inExt ? `<select class="pin extsel${r.externalId ? ' linked' : ''}${r.needId ? ' need' : ''}" data-k="ext_pick" aria-label="Quelle location ou quel prêt">${
      r.needId ? `<option value="__keepneed" selected>${needTxt} (à saisir)</option><option value="__cancel">Annuler le besoin</option>${extOpts}`
               : `<option value="" ${r.externalId ? '' : 'selected'}>— laquelle ? —</option>${extOpts}<option value="__need">+ À louer / à emprunter…</option>`}</select>` : '';
    return inExt ? sel + extSel : sel + lampSel;
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
      case 'position': return can_ ? `<select class="pin" data-k="position" aria-label="Position"><option value="">—</option>${POSITION_GROUPS.map((g) => `<optgroup label="${esc(g.label)}">${g.items.map((p) => `<option ${p === r.position ? 'selected' : ''}>${esc(p)}</option>`).join('')}</optgroup>`).join('')}</select>` : `<span>${esc(r.position) || '<i class="muted">—</i>'}</span>`;
      case 'state': {   // état : clic = vert / vide ; double clic = rouge (à faire) ; clic sur rouge = la note ; double clic sur rouge = vide
        const st = r.state, lab = st === 'ok' ? 'Focus fait' : st === 'todo' ? 'À faire' : 'Pas d\'état';
        return `<button type="button" class="stbtn st-${st || 'none'}" data-act="state" aria-label="État : ${lab}${can_ ? '. Entrée : cocher ou décocher, Maj + Entrée : à faire' : ''}${st === 'todo' && r.stateNote ? ' (note disponible)' : ''}"><span aria-hidden="true">${st === 'ok' ? '✓' : st === 'todo' ? '!' : ''}</span></button>`;
      }
      case 'notes': return can_ ? `<input class="pin" data-k="notes" value="${esc(r.notes)}" maxlength="500" autocomplete="off" aria-label="Notes">` : `<span>${esc(r.notes) || '<i class="muted">—</i>'}</span>`;
    }
  };
  const rowHtml = (r: PatchRow, ed: Set<Col>): string => `<tr data-key="${esc(r.key)}" class="${r.state === 'ok' ? 'done' : r.state === 'todo' ? 'todo' : ''}${selMode && sel.has(r.key) ? ' picked' : ''}" ${r.updatedAt ? `title="Modifié ${esc(fmtDateTime(r.updatedAt))}${r.updatedBy ? ' par ' + esc(r.updatedBy) : ''}"` : ''}>${selMode ? `<td class="selc" data-c="sel"><input type="checkbox" class="selbox" data-key="${esc(r.key)}" ${sel.has(r.key) ? 'checked' : ''} aria-label="Sélectionner ${esc(rowLabel(r))}"></td>` : ''}${COLS.map((c) => `<td data-label="${c.label}" data-c="${c.k}">${cell(r, c.k, ed)}</td>`).join('')}<td class="rowact" data-c="act">${ed.has('id') ? `<button class="btn mini" data-act="line-del" aria-label="Supprimer la ligne">Suppr.</button>` : ''}</td></tr>`;

  /** Choix du modèle d'une ligne sans projecteur : catalogue, texte libre, ou nouveau modèle ajouté au catalogue. */
  /** « + À louer / à emprunter… » : on choisit le modèle (et la lampe d'un PAR) ; la demande de matériel monte de 1 et l'alarme « manque » joue si le stock ne suffit pas. */
  async function needForm(root: HTMLElement, key: string) {
    const d = view(), r = rowsNow().find((x) => x.key === key);
    const models = [...d.models].sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    const f = await openForm('À louer / à emprunter', [
      { name: 'm', label: 'Modèle', type: 'select', search: true, required: true, options: models.map((m): [string, string] => [m.id, m.name]) },
      { name: 'l', label: 'Lampe (PAR seulement)', type: 'select', options: [['', '—'], ...[...d.lamps].sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true })).map((l): [string, string] => [l.id, l.name])] }
    ], { submit: 'Ajouter au matériel demandé' });
    if (!f || !r?.lineId) { paintRow(root, key); return; }
    const m = d.models.find((x) => x.id === f.m), par = /^PAR/i.test(d.types.find((t) => t.id === m?.type_id)?.name ?? '');
    if (par && !f.l) { toast('Choisis la lampe du PAR.'); paintRow(root, key); return; }
    busy++; setStat(root, 'Enregistrement…');
    const res = await rpcCall('patch_need_set', { p_show: showId, p_line: r.lineId, p_model: f.m, p_lamp: par ? f.l : null }); busy--; seed();
    if (res.error) { setStat(root, res.error, true); toast(res.error); paintRow(root, key); return; }
    extMode.delete(key); setStat(root, 'Ajouté au matériel demandé ✓'); paint(root);
  }
  async function pickModel(root: HTMLElement, key: string, v: string) {
    if (v === '__keep') return;                                   // texte libre déjà en place : rien à faire
    if (v === '__ext') { extMode.add(key); paintRow(root, key); return; }   // « Location / prêt… » : la 2e liste apparaît pour choisir laquelle
    const was = rowsNow().find((x) => x.key === key);
    if (extMode.delete(key) || was?.externalId) save(root, key, 'external_id', '');   // on quitte le mode location : la ligne est détachée
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
    const ed = edSet(), rows = ordered(), exts = externalStatus(view(), showId, lines);
    const pt = host.querySelector<HTMLElement>('.ptable'), keepTop = pt?.scrollTop ?? 0, keepLeft = pt?.scrollLeft ?? 0;   // on garde la position de défilement au redessin
    const last = rows.filter((r) => r.updatedAt).sort((a, b) => b.updatedAt!.localeCompare(a.updatedAt!))[0];
    for (const k of [...sel]) if (!rows.some((r) => r.key === k)) sel.delete(k);   // une ligne disparue n'est plus cochée
    if (selMode && !ed.size) { selMode = false; sel.clear(); }   // plus de droit (hors ligne…) : on quitte la sélection
    const arrow = (c: Col) => (sortCol === c ? (dir === 1 ? ' ▲' : ' ▼') : '');
    host.innerHTML = `<div class="phead"><a href="#/show/${esc(showId)}" class="sub">‹ ${esc(show.name)}</a>
      <div class="row wrap"><h1 class="grow">Patch / Focus</h1><span id="pstat" class="sub ${statErr ? 'warn' : ''}" role="status">${esc(stat)}</span></div>
      <div class="sub">${esc(show.name)} · du ${fmtDay(show.start_date)} au ${fmtDay(show.end_date)} · ${rows.length} ligne${rows.length > 1 ? 's' : ''} · ${stateText(rows)}${last ? ` · dernière modification ${esc(fmtDateTime(last.updatedAt!))}${last.updatedBy ? ' par ' + esc(last.updatedBy) : ''}` : ''}</div>
      ${exts.length ? `<div class="sub extinfo">Locations / prêts : ${exts.map((x) => `<span class="${x.placed === x.qty ? '' : 'extwarn'}">${esc(x.short)} <b>${esc(extCount(x))}</b></span>`).join(' · ')}</div>` : ''}
      ${!navigator.onLine ? '<div class="banner">Hors ligne : la feuille est en lecture seule.</div>' : ed.size === 0 ? '<div class="sub">Consultation seulement : tu n\'es pas assigné à ce spectacle.</div>'
        : !canActShow(showId) ? '<div class="sub">Tu peux modifier la grada, la courbe et les gélatines.</div>' : ''}
      <div class="row wrap noprint">${ed.has('id') ? '<button class="btn primary" data-act="line-add">+ Ajouter une ligne</button>' : ''}<button class="btn" data-act="pdf">PDF</button>${ed.size && rows.length ? `<button class="btn${selMode ? ' on' : ''}" data-act="sel-toggle" aria-pressed="${selMode}">Sélectionner</button>` : ''}${ed.has('id') ? '<details class="multi eraser"><summary class="btn">Effacer…</summary><div class="opts"><button class="btn" data-act="clear-circuits">Effacer les circuits</button><button class="btn" data-act="clear-gels">Effacer les gels et accessoires</button><button class="btn" data-act="clear-all">Effacer la feuille, garder les projecteurs affectés</button></div></details>' : ''}</div>
      ${selMode ? `<div class="selbar noprint" role="toolbar" aria-label="Actions sur la sélection"><b role="status">${lignes(sel.size)} sélectionnée${sel.size > 1 ? 's' : ''}</b><button class="btn mini" data-act="sel-all">Tout</button><button class="btn mini primary" data-act="sel-edit" ${sel.size ? '' : 'disabled'}>Modifier…</button>${ed.has('id') ? `<button class="btn mini danger" data-act="sel-del" ${sel.size ? '' : 'disabled'}>Supprimer…</button>` : ''}<button class="btn mini" data-act="sel-off" aria-label="Quitter la sélection">✕</button></div>` : ''}</div>
      <div class="row patch-sortbar"><label class="f grow">Trier par<select id="psort">${COLS.map((c) => `<option value="${c.k}" ${c.k === sortCol ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
        <button class="btn" data-act="pdir" aria-label="Inverser le tri">${dir === 1 ? '▲' : '▼'}</button></div>
      <div class="ptable"><table class="patch${selMode ? ' sel' : ''}"><thead><tr>${selMode ? '<th scope="col" class="selc" data-c="sel"><span class="sr">Sélection</span></th>' : ''}${COLS.map((c) => `<th scope="col" data-c="${c.k}" aria-sort="${sortCol === c.k ? (dir === 1 ? 'ascending' : 'descending') : 'none'}"><button data-sort="${c.k}" aria-label="${c.label}" title="${c.label}">${c.short ?? c.label}${arrow(c.k)}</button><span class="rz" data-rz="${c.k}" title="Tire pour changer la largeur (double-clic : largeur automatique)" aria-hidden="true"></span></th>`).join('')}<th scope="col" class="rowact"><span class="sr">Actions</span></th></tr></thead>
        <tbody>${rows.map((r) => rowHtml(r, ed)).join('') || '<tr><td colspan="14" class="empty">Aucun projecteur affecté à ce spectacle.</td></tr>'}</tbody></table></div>`;
    fitTable(root);
    const nt = host.querySelector<HTMLElement>('.ptable'); if (nt) { nt.scrollTop = keepTop; nt.scrollLeft = keepLeft; }
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
    if (r && tr) {
      const ae = document.activeElement as HTMLElement | null, k = ae && tr.contains(ae) ? ae.dataset?.k : null;   // le curseur était dans cette ligne ?
      tr.outerHTML = rowHtml(r, edSet());
      if (k) [...root.querySelectorAll<HTMLElement>('tbody tr')].find((x) => x.dataset.key === key)?.querySelector<HTMLElement>(`[data-k="${k}"]`)?.focus({ preventScroll: true });   // on le remet au même champ
    }
  }
  const setStat = (root: HTMLElement, t: string, err = false) => { stat = t; statErr = err; const e = root.querySelector('#pstat'); if (e) { e.textContent = t; e.className = 'sub' + (err ? ' warn' : ''); } };

  /** Envoie un champ au serveur (les envois se suivent) puis met la ligne locale à jour. */
  function save(root: HTMLElement, key: string, field: string, value: unknown) {
    const r = rowsNow().find((x) => x.key === key); if (!r) return;
    busy++; setStat(root, 'Enregistrement…');
    const done = queue = queue.then(async () => {
      const cur = rowsNow().find((x) => x.key === key) ?? r;   // l'ID de ligne a pu être créé par un envoi précédent
      const send = () => supabase.rpc('set_patch_field', { p_show: showId, p_item: cur.itemId, p_line: cur.lineId, p_field: field, p_value: value });
      let { data, error } = await send();
      // coupure réseau passagère (« Failed to fetch ») : l'envoi est rejouable sans risque (il fixe une valeur), on réessaie une fois
      if (error && /failed to fetch|network|load failed/i.test(error.message)) { await new Promise((ok) => setTimeout(ok, 1200)); ({ data, error } = await send()); }
      busy--;
      if (error || !data) { setStat(root, error && /failed to fetch|network|load failed/i.test(error.message) ? 'Connexion perdue : réessaie dans un instant' : error?.message ?? 'Enregistrement impossible', true); paintRow(root, key); return; }
      const line = data as PatchLine; const i = lines.findIndex((l) => l.id === line.id);
      if (i >= 0) lines[i] = line; else lines.push(line);
      upsertPatchLine(line);   // et dans les données de l'appli : la feuille retrouve tout si on la quitte puis qu'on y revient
      setStat(root, 'Enregistré ✓ ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
      if (field === 'curve' || field === 'state') paintRow(root, key);   // DMX actif seulement avec DIRECT ; l'état change la couleur de la ligne et l'indice de note
    });
    return done;
  }

  // ---- état de la ligne : vide → vert (fait) → rouge (à faire + note) → vide ----
  const stBusy = new Set<string>();   // lignes dont un changement d'état est en cours (évite le double clic)
  const rowLabel = (r: PatchRow): string => (r.itemId === null ? 'ligne N/C' : `projecteur ${r.itemId}`) + (r.circuit ? ` (circuit ${r.circuit})` : '');
  /** Fenêtre de saisie de la note « à faire » ; renvoie le texte, ou null si on annule. */
  const askNote = async (r: PatchRow): Promise<string | null> => {
    const f = await openForm('À faire : ' + rowLabel(r), [{ name: 'note', label: 'Qu\'y a-t-il à faire ?', type: 'textarea', value: r.stateNote, hint: '300 caractères au plus. La note s\'affiche en touchant (ou en survolant) le rond rouge.' }], { submit: 'Enregistrer' });
    return f ? f.note.trim().slice(0, 300) : null;
  };
  /** Un clic (après 0,28 s sans second clic) : vide ↔ vert ; sur un rouge, montre la note. Un double clic : rouge + fenêtre de note ; sur un rouge, retour à vide. */
  const stateTimers = new Map<string, number>();
  const stateAct = async (root: HTMLElement, key: string, dbl: boolean, btn: HTMLElement) => {
    const r = rowsNow().find((x) => x.key === key); if (!r || stBusy.has(key)) return;
    if (r.state === 'todo' && !dbl) { if (pop && popPinned && pop.dataset.key === key) hidePop(); else showPop(root, btn, true); return; }   // clic sur rouge : bulle de la note (touchable aussi pour les non-éditeurs)
    if (!edSet().has('state')) return;
    stBusy.add(key); hidePop();
    try {
      if (!dbl) await save(root, key, 'state', { s: r.state === 'ok' ? '' : 'ok' });                       // clic : vert, ou retour à vide
      else if (r.state === 'todo') await save(root, key, 'state', { s: '' });                                // double clic sur rouge : vide
      else { const note = await askNote(r); if (note !== null) await save(root, key, 'state', { s: 'todo', note }); }   // double clic : rouge + note (annuler = rien ne change)
    } finally { stBusy.delete(key); }
  };
  /** Gère un clic sur le rond : un second clic dans les 0,28 s devient un double clic (détecté à la main : fiable aussi au toucher). */
  const stateClick = (root: HTMLElement, key: string, btn: HTMLElement, forceDouble = false) => {
    const t = stateTimers.get(key);
    if (t !== undefined) { window.clearTimeout(t); stateTimers.delete(key); void stateAct(root, key, true, btn); return; }
    if (forceDouble) { void stateAct(root, key, true, btn); return; }
    stateTimers.set(key, window.setTimeout(() => { stateTimers.delete(key); void stateAct(root, key, false, btn); }, 280));
  };
  const editNote = async (root: HTMLElement, key: string) => {
    const r = rowsNow().find((x) => x.key === key); if (!r || r.state !== 'todo' || stBusy.has(key)) return;
    stBusy.add(key); hidePop();
    try { const note = await askNote(r); if (note !== null) await save(root, key, 'state', { s: 'todo', note }); } finally { stBusy.delete(key); }
  };
  // bulle de la note : survol sur ordinateur, toucher sur téléphone ; le texte vient d'un utilisateur → textContent
  let pop: HTMLElement | null = null, popPinned = false, popTimer = 0;
  function hidePop() { window.clearTimeout(popTimer); pop?.remove(); pop = null; popPinned = false; }
  function showPop(root: HTMLElement, btn: HTMLElement, pinned: boolean) {
    const key = btn.closest<HTMLElement>('tr[data-key]')?.dataset.key, r = key ? rowsNow().find((x) => x.key === key) : undefined; if (!r || !key) return;
    hidePop();
    const el = document.createElement('div'); el.className = 'stpop'; el.setAttribute('role', 'tooltip'); el.dataset.key = key;
    const p = document.createElement('p'); p.textContent = r.stateNote || 'Pas de note.'; el.append(p);
    if (pinned && edSet().has('state')) {   // « Modifier la note » : seulement quand la bulle est ouverte par un toucher
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn mini'; b.textContent = 'Modifier la note';
      b.addEventListener('click', () => void editNote(root, key)); el.append(b);
    }
    el.addEventListener('mouseenter', () => window.clearTimeout(popTimer));
    el.addEventListener('mouseleave', () => { if (!popPinned) popTimer = window.setTimeout(hidePop, 150); });
    document.body.append(el); pop = el; popPinned = pinned;
    const b = btn.getBoundingClientRect();   // posée sous la pastille (au-dessus s'il manque de place), sans sortir de l'écran
    el.style.left = Math.max(6, Math.min(b.left, window.innerWidth - el.offsetWidth - 6)) + 'px';
    el.style.top = (b.bottom + el.offsetHeight + 8 > window.innerHeight ? Math.max(6, b.top - el.offsetHeight - 4) : b.bottom + 4) + 'px';
  }

  return {
    mount(root) {
      seed();
      root.innerHTML = '<div class="page patch-page"><div id="phost"></div></div>';
      resort(); paint(root);
      root.addEventListener('click', async (e) => {
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
        const sb = t.closest<HTMLElement>('[data-act="state"]');
        if (sb) { const k = sb.closest<HTMLElement>('tr[data-key]')?.dataset.key; if (k) stateClick(root, k, sb, (e as MouseEvent).detail === 0 && (e as MouseEvent).shiftKey); return; }   // détail 0 = clavier : Maj + Entrée = « à faire »
        if (t.closest('[data-act="sel-toggle"]')) { selMode = !selMode; sel.clear(); lastSel = null; paint(root); return; }   // entrer / sortir du mode sélection
        if (t.closest('[data-act="sel-off"]')) { selMode = false; sel.clear(); lastSel = null; paint(root); return; }
        if (t.closest('[data-act="sel-all"]')) { const all = ordered().map((r) => r.key); if (sel.size === all.length) sel.clear(); else all.forEach((k) => sel.add(k)); paint(root); return; }   // « Tout » : les lignes affichées ; un 2e appui décoche
        if (t.closest('[data-act="sel-edit"]')) { if (sel.size) void batchEdit(root); return; }
        if (t.closest('[data-act="sel-del"]')) { if (sel.size) void batchDelete(root); return; }
        const sbx = t.closest<HTMLInputElement>('input.selbox');
        if (sbx) {   // case d'une ligne ; Maj + clic = toutes les lignes entre la dernière case touchée et celle-ci
          const k = sbx.dataset.key!, on = sbx.checked;
          const ks = (e as MouseEvent).shiftKey && lastSel ? rangeKeys(ordered().map((r) => r.key), lastSel, k) : [k];
          for (const x of ks) { if (on) sel.add(x); else sel.delete(x); }
          lastSel = k; paint(root); return;
        }
        const clr = t.closest<HTMLElement>('[data-act="clear-circuits"], [data-act="clear-gels"]');
        if (clr) {   // vider les circuits (gradas gardées) ou les gélatines + accessoires, pour repartir d'un montage déjà patché
          clr.closest('details')?.removeAttribute('open');   // le menu se referme
          const circ = clr.dataset.act === 'clear-circuits';
          if (!await confirmBox(circ ? 'Effacer tous les circuits de cette feuille ? Les gradas sont conservées.' : 'Effacer toutes les gélatines et tous les accessoires de cette feuille ?')) return;
          void (async () => {
            busy++; setStat(root, 'Effacement…');
            const r = await rpcCall(circ ? 'patch_clear_circuits' : 'patch_clear_gels_acc', { p_show: showId }); busy--; seed();
            if (r.error) { setStat(root, r.error, true); toast(r.error); return; }
            setStat(root, circ ? 'Circuits effacés ✓' : 'Gélatines et accessoires effacés ✓'); paint(root);
          })();
          return;
        }
        if (t.closest('[data-act="clear-all"]')) {   // effacer toute la feuille ; les projecteurs restent affectés
          t.closest('details')?.removeAttribute('open');
          if (!await confirmBox('Effacer toute la feuille de patch ? Circuits, gradas, courbes, DMX, positions, accessoires, gélatines, états et notes disparaissent, ainsi que les lignes sans projecteur. Les projecteurs restent affectés au spectacle. Impossible d\'annuler.')) return;
          void (async () => {
            busy++; setStat(root, 'Effacement…');
            const r = await rpcCall('patch_clear_all', { p_show: showId }); busy--; seed();
            if (r.error) { setStat(root, r.error, true); toast(r.error); return; }
            selMode = false; sel.clear(); resort(); setStat(root, 'Feuille effacée ✓'); paint(root);
          })();
          return;
        }
        if (t.closest('[data-act="pdf"]')) {   // PDF horodaté, dans l'ordre affiché à l'écran
          void (async () => {
            try {
              const { buildPatchPdf, PDF_KINDS } = await import('../patchPdf'); const { deliverPdf } = await import('../ui/deliverPdf');
              const f = await openForm('Quel PDF ?', [{ name: 'k', label: 'Contenu', type: 'select', options: PDF_KINDS, value: 'all' }], { submit: 'Générer le PDF' });   // choix du classement / des listes
              if (!f) return;   // annulé
              const { blob, filename } = await buildPatchPdf(view(), showId, ordered(), new Date(), f.k as import('../patchPdf').PatchPdfKind);
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
      // téléphone (écran tactile) : toucher la cellule ID ouvre directement le scan de QR code (la liste d'ID reste dans la fenêtre, avec noID)
      const coarse = () => window.matchMedia('(pointer: coarse)').matches;
      const phoneId = (e: Event): HTMLElement | null => (coarse() && edSet().has('id') ? (e.target as HTMLElement).closest<HTMLElement>('select.idsel') : null);
      root.addEventListener('mousedown', (e) => { if (phoneId(e)) e.preventDefault(); }, true);   // empêche l'ouverture de la liste native
      root.addEventListener('click', (e) => {
        const sel = phoneId(e); if (!sel) return;
        e.preventDefault(); e.stopImmediatePropagation(); sel.blur();
        const key = sel.closest<HTMLElement>('tr[data-key]')?.dataset.key; if (key) void act(root, key, 'id', 'scan');
      }, true);
      // Entrée dans un champ de saisie : on enregistre, puis le curseur descend sur le même champ de la ligne suivante (Tab, lui, passe à la colonne suivante : réglage normal du navigateur).
      // L'ordre des lignes ne bouge pas pendant la saisie : « la ligne suivante » est celle qu'on voit juste dessous.
      root.addEventListener('keydown', (e) => {
        const t = e.target as HTMLInputElement;
        if (e.key !== 'Enter' || e.isComposing || !(t instanceof HTMLInputElement) || t.type === 'checkbox' || !t.classList.contains('pin')) return;
        const tr = t.closest<HTMLElement>('tr[data-key]'), k = t.dataset.k; if (!tr || !k) return;
        e.preventDefault();
        const key = tr.dataset.key!;
        skipChange = t;                                                           // évite un 2e enregistrement quand le champ perdra le curseur
        save(root, key, k, t.value.trim());
        const next = tr.nextElementSibling as HTMLElement | null;                 // ligne juste en dessous (déjà à l'écran)
        if (!next) { t.blur(); return; }                                          // dernière ligne : on valide et on pose le clavier
        const nk = next.dataset.key!;
        queue = queue.then(() => {
          const row = [...root.querySelectorAll<HTMLElement>('tbody tr')].find((x) => x.dataset.key === nk);
          const inp = row?.querySelector<HTMLInputElement>(`input.pin[data-k="${k}"]`) ?? row?.querySelector<HTMLInputElement>('input.pin');   // même colonne, sinon le 1er champ de la ligne
          inp?.focus(); inp?.select();                                            // le curseur arrive en sélectionnant le contenu : on peut taper par-dessus
          inp?.scrollIntoView({ block: 'nearest' });
        });
      });
      root.addEventListener('change', (e) => {
        const t = e.target as HTMLInputElement | HTMLSelectElement;
        if (t === skipChange) { skipChange = null; return; }              // déjà enregistré par la touche Entrée
        if (t.id === 'psort') { sortCol = t.value as Col; dir = 1; resort(); paint(root); return; }
        const tr = t.closest<HTMLElement>('tr[data-key]'); if (!tr) return;
        const key = tr.dataset.key!;
        const multi = t.closest<HTMLElement>('details.multi');
        if (multi) {
          const vals = [...multi.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map((x) => x.dataset.v!);   // cases cochées
          const sm = multi.querySelector('summary');   // texte affiché dans la cellule : mis à jour tout de suite (le menu reste ouvert, la ligne n'est pas redessinée)
          if (sm) { sm.textContent = labelsOf(ACCESSORIES, vals); if (!vals.length) { const i = document.createElement('i'); i.className = 'muted'; i.textContent = '—'; sm.replaceChildren(i); } }
          save(root, key, multi.dataset.k!, vals); return;
        }
        const k = (t as HTMLElement).dataset.k; if (!k) return;
        if (k === 'curve') { save(root, key, 'curve', [t.value]); return; }   // courbe : un seul choix
        if (k === 'id') { void act(root, key, 'id', t.value); return; }
        if (k === 'model_pick') { void pickModel(root, key, t.value); return; }   // modèle d'une ligne sans projecteur
        if (k === 'lamp_pick') { save(root, key, 'lamp_id', t.value); return; }
        if (k === 'ext_pick' && t.value === '__keepneed') return;                    // besoin déjà en place : rien à faire
        if (k === 'ext_pick' && t.value === '__cancel') { extMode.delete(key); save(root, key, 'model_id', ''); queue = queue.then(() => paintRow(root, key)); return; }   // abandonne le besoin
        if (k === 'ext_pick' && t.value === '__need') { void needForm(root, key); return; }   // « + À louer / à emprunter… »
        if (k === 'ext_pick') { save(root, key, 'external_id', t.value); queue = queue.then(() => paint(root)); return; }   // rattachement à une location : le compteur et le modèle sont mis à jour   // cellule ID : changement de projecteur
        save(root, key, k, t.value.trim());
      });
      const hoverOk = () => window.matchMedia('(hover: hover)').matches;   // survol : ordinateur seulement
      root.addEventListener('mouseover', (e) => { const n = (e.target as HTMLElement).closest<HTMLElement>('.stbtn.st-todo'); if (n && hoverOk() && !popPinned) { window.clearTimeout(popTimer); showPop(root, n, false); } });
      root.addEventListener('mouseout', (e) => { if ((e.target as HTMLElement).closest('.stbtn.st-todo') && !popPinned) popTimer = window.setTimeout(hidePop, 150); });
      const outside = (e: Event) => { if (pop && popPinned && !pop.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.stbtn.st-todo')) hidePop(); };
      document.addEventListener('click', outside);
      // menu des accessoires : posé en « fixed » sous la case (ou au-dessus s'il manque de place), pour ne pas être coupé par la zone de défilement du tableau
      root.addEventListener('toggle', (e) => {
        const d = e.target as HTMLDetailsElement; if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('multi') || !d.open) return;
        const box = d.querySelector<HTMLElement>('.opts'), sm = d.querySelector('summary'); if (!box || !sm) return;
        const r = sm.getBoundingClientRect();
        box.style.position = 'fixed'; box.style.left = Math.max(4, Math.min(r.left, window.innerWidth - box.offsetWidth - 4)) + 'px';
        box.style.top = (r.bottom + box.offsetHeight + 4 > window.innerHeight ? Math.max(4, r.top - box.offsetHeight) : r.bottom) + 'px';   // en haut si le bas de l'écran est trop proche
      }, true);
      root.addEventListener('scroll', () => { hidePop(); root.querySelectorAll<HTMLDetailsElement>('details.multi[open]').forEach((d) => { d.open = false; }); }, true);   // défiler ferme le menu (sa place ne suivrait plus)
      // largeur des colonnes réglable à la souris (ordinateur) : poignée au bord de chaque titre, mémorisée sur cet appareil
      let widths: Widths = loadWidths();
      const colStyle = document.createElement('style'); document.head.append(colStyle);
      const applyCols = () => { colStyle.textContent = colCss(widths); };
      applyCols();
      root.addEventListener('pointerdown', (e) => {
        const h = (e.target as HTMLElement).closest<HTMLElement>('[data-rz]'); if (!h || e.button !== 0) return;
        const col = h.dataset.rz!, th = h.closest('th')!;
        e.preventDefault(); h.setPointerCapture(e.pointerId);
        const x0 = e.clientX, w0 = th.getBoundingClientRect().width;
        const move = (ev: PointerEvent) => { widths = { ...widths, [col]: clampW(w0 + ev.clientX - x0) }; applyCols(); };
        const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); saveWidths(widths); };
        h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
      });
      root.addEventListener('dblclick', (e) => {   // double-clic sur la poignée : largeur automatique pour cette colonne
        const h = (e.target as HTMLElement).closest<HTMLElement>('[data-rz]'); if (!h) return;
        const { [h.dataset.rz!]: _gone, ...rest } = widths; widths = rest; applyCols(); saveWidths(widths);
      });
      // un menu à cases se ferme quand on touche ailleurs
      const repaint = () => paint(root);
      document.addEventListener('click', closeMenus);
      const refit = () => fitTable(root);   // rotation ou redimensionnement
      window.addEventListener('resize', refit); window.addEventListener('orientationchange', refit);
      window.addEventListener('online', repaint); window.addEventListener('offline', repaint);
      return () => { hidePop(); colStyle.remove(); document.removeEventListener('click', outside); document.removeEventListener('click', closeMenus); window.removeEventListener('resize', refit); window.removeEventListener('orientationchange', refit); window.removeEventListener('online', repaint); window.removeEventListener('offline', repaint); };   // nettoyage à la sortie de la page
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
