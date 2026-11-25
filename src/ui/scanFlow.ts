// Écran de scan du spectacle : menu « Affecter des positions » / « Patcher », puis le mode choisi.
import QrScanner from 'qr-scanner';
import { POSITION_GROUPS } from '../patch';
import { rpcCall, view } from '../store';
import { parseScan } from '../logic';
import { classifyScan, splitLot } from '../scanPositions';
import { cashBeep } from './beep';
import { toast } from './toast';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

/** Ouvre l'écran de scan pour un spectacle ; `onChange` est rappelé après chaque modification (pour rafraîchir la fiche). */
export function openScanFlow(showId: string, onChange: () => void): void {
  const dlg = el('dialog', 'dlg scanflow'); document.body.appendChild(dlg);
  let stop = () => {};
  const close = () => { stop(); dlg.close(); dlg.remove(); onChange(); };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });   // Échap / retour : on ferme proprement (caméra coupée)

  /** Menu de départ : deux gros choix. */
  function menu() {
    stop(); stop = () => {};
    const h = el('h2', '', 'Scanner'); h.tabIndex = -1;
    const a = el('button', 'btn scan-choice', ''); a.type = 'button'; a.append(el('b', '', 'Affecter des positions'), el('small', '', 'Choisir une position, scanner le lot, valider'));
    a.addEventListener('click', positions);
    const b = el('button', 'btn scan-choice', ''); b.type = 'button'; b.disabled = true; b.append(el('b', '', 'Patcher'), el('small', '', 'Grada, DIRECT, DMX : bientôt'));
    const q = el('button', 'btn', 'Quitter'); q.type = 'button'; q.addEventListener('click', close);
    dlg.replaceChildren(h, a, b, q); h.focus();
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
      if (outAll.length && !window.confirm(`${outAll.length} projecteur${outAll.length > 1 ? 's ne sont pas encore affectés' : ' n\'est pas encore affecté'} à ce spectacle (n° ${outAll.join(', ')}). Les affecter et leur donner la position ${pos} ?`)) return;
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
    scanner.start().catch((e) => say(`Caméra indisponible (${String(e)}). Saisis les numéros à la main.`, true));
    stop = () => { scanner.stop(); scanner.destroy(); };
    h.focus();
  }

  menu(); dlg.showModal();
}
