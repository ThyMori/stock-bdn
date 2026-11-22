import type { ViewFactory } from '../router';
import { can, canActShow, view } from '../store';
import { supabase } from '../supabase';
import { esc, fmtDateTime } from '../logic';
import { gelCss } from '../types';
import { gelColorOf } from '../gels';
import { ACCESSORIES, COLS, CURVES, POSITIONS, buildRows, editableCols, labelsOf, sortRows } from '../patch';
import type { Col, PatchLine, PatchRow } from '../patch';
import { fmtDay } from './agenda';

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

  const cell = (r: PatchRow, c: Col, ed: Set<Col>): string => {
    const can_ = ed.has(c);
    switch (c) {
      case 'circuit': case 'dimmer': return can_ ? `<input class="pin num" data-k="${c}" value="${esc(r[c])}" maxlength="30" autocomplete="off" aria-label="${c === 'circuit' ? 'Circuit' : 'Grada'}">` : `<span class="num">${esc(r[c]) || '<i class="muted">—</i>'}</span>`;
      case 'curve': case 'accessories': {
        const list = c === 'curve' ? CURVES : ACCESSORIES, vals = r[c];
        const txt = c === 'curve' && vals.includes('direct')
          ? list.filter((x) => vals.includes(x.k)).map((x) => (x.k === 'direct' ? `<b class="direct">DIRECT</b>` : esc(x.label))).join(' · ')
          : esc(labelsOf(list, vals));
        if (!can_) return `<span>${txt || '<i class="muted">—</i>'}</span>`;
        return `<details class="multi" data-k="${c}"><summary>${txt || '<i class="muted">—</i>'}</summary><div class="opts">${list.map((x) =>
          `<label><input type="checkbox" data-v="${x.k}" ${vals.includes(x.k) ? 'checked' : ''}> ${x.k === 'direct' ? '<b class="direct">DIRECT</b>' : esc(x.label)}</label>`).join('')}</div></details>`;
      }
      case 'dmx': return can_ && r.curve.includes('direct') ? `<input class="pin num" data-k="dmx" value="${esc(r.dmx)}" placeholder="1-120" maxlength="7" inputmode="numeric" autocomplete="off" aria-label="Adresse DMX, univers-adresse">`
        : r.curve.includes('direct') ? `<span class="num">${esc(r.dmx) || '<i class="muted">—</i>'}</span>` : '<i class="muted">—</i>';
      case 'id': return r.itemId === null ? '<span class="muted">N/C</span>' : `<a class="num idlink" href="#/item/${r.itemId}">${r.itemId}</a>`;
      case 'model': return r.itemId === null && can_ ? `<input class="pin" data-k="model_text" value="${esc(r.model)}" maxlength="80" autocomplete="off" aria-label="Modèle">` : `<span>${esc(r.model) || '<i class="muted">—</i>'}</span>`;
      case 'gels': return r.gels.length ? r.gels.map((g) => `<span class="gel"><i style="background:${gelCss(gelColorOf(g))}"></i>${esc(g)}</span>`).join(' ') : '<i class="muted">—</i>';
      case 'position': return can_ ? `<select class="pin" data-k="position" aria-label="Position"><option value="">—</option>${POSITIONS.map((p) => `<option ${p === r.position ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>` : `<span>${esc(r.position) || '<i class="muted">—</i>'}</span>`;
      case 'focus': return `<input type="checkbox" class="fcb" data-k="focus" ${r.focus ? 'checked' : ''} ${can_ ? '' : 'disabled'} aria-label="Focus fait">`;
      case 'notes': return can_ ? `<input class="pin" data-k="notes" value="${esc(r.notes)}" maxlength="500" autocomplete="off" aria-label="Notes">` : `<span>${esc(r.notes) || '<i class="muted">—</i>'}</span>`;
    }
  };
  const rowHtml = (r: PatchRow, ed: Set<Col>): string => `<tr data-key="${esc(r.key)}" class="${r.focus ? 'done' : ''}" ${r.updatedAt ? `title="Modifié ${esc(fmtDateTime(r.updatedAt))}${r.updatedBy ? ' par ' + esc(r.updatedBy) : ''}"` : ''}>${COLS.map((c) => `<td data-label="${c.label}" data-c="${c.k}">${cell(r, c.k, ed)}</td>`).join('')}</tr>`;

  const edSet = () => (navigator.onLine ? editableCols(canActShow(showId), can('technicien')) : new Set<Col>());

  function paint(root: HTMLElement) {
    const show = view().shows.find((s) => s.id === showId);
    const host = root.querySelector('#phost')!;
    if (!show) { host.innerHTML = '<div class="card empty">Spectacle introuvable.<br><a href="#/shows">Retour aux spectacles</a></div>'; return; }
    const ed = edSet(), rows = ordered();
    const last = rows.filter((r) => r.updatedAt).sort((a, b) => b.updatedAt!.localeCompare(a.updatedAt!))[0];
    const arrow = (c: Col) => (sortCol === c ? (dir === 1 ? ' ▲' : ' ▼') : '');
    host.innerHTML = `<a href="#/show/${esc(showId)}" class="sub">‹ ${esc(show.name)}</a>
      <div class="row wrap"><h1 class="grow">Patch / Focus</h1><span id="pstat" class="sub ${statErr ? 'warn' : ''}" role="status">${esc(stat)}</span></div>
      <div class="sub">${esc(show.name)} · du ${fmtDay(show.start_date)} au ${fmtDay(show.end_date)} · ${rows.length} ligne${rows.length > 1 ? 's' : ''} · focus ${rows.filter((r) => r.focus).length}/${rows.length}${last ? ` · dernière modification ${esc(fmtDateTime(last.updatedAt!))}${last.updatedBy ? ' par ' + esc(last.updatedBy) : ''}` : ''}</div>
      ${!navigator.onLine ? '<div class="banner">Hors ligne : la feuille est en lecture seule.</div>' : ed.size === 0 ? '<div class="sub">Consultation seulement : tu n\'es pas assigné à ce spectacle.</div>'
        : !canActShow(showId) ? '<div class="sub">Tu peux modifier la grada et la courbe.</div>' : ''}
      <div class="row patch-sortbar"><label class="f grow">Trier par<select id="psort">${COLS.map((c) => `<option value="${c.k}" ${c.k === sortCol ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
        <button class="btn" data-act="pdir" aria-label="Inverser le tri">${dir === 1 ? '▲' : '▼'}</button></div>
      <table class="patch"><thead><tr>${COLS.map((c) => `<th scope="col" aria-sort="${sortCol === c.k ? (dir === 1 ? 'ascending' : 'descending') : 'none'}"><button data-sort="${c.k}">${c.label}${arrow(c.k)}</button></th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => rowHtml(r, ed)).join('') || '<tr><td colspan="11" class="empty">Aucun projecteur affecté à ce spectacle.</td></tr>'}</tbody></table>`;
  }
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
        if (t.closest('[data-act="pdir"]')) { dir = dir === 1 ? -1 : 1; resort(); paint(root); }
      });
      root.addEventListener('change', (e) => {
        const t = e.target as HTMLInputElement | HTMLSelectElement;
        if (t.id === 'psort') { sortCol = t.value as Col; dir = 1; resort(); paint(root); return; }
        const tr = t.closest<HTMLElement>('tr[data-key]'); if (!tr) return;
        const key = tr.dataset.key!;
        const multi = t.closest<HTMLElement>('details.multi');
        if (multi) { save(root, key, multi.dataset.k!, [...multi.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map((x) => x.dataset.v!)); return; }
        const k = (t as HTMLElement).dataset.k; if (!k) return;
        save(root, key, k, k === 'focus' ? (t as HTMLInputElement).checked : t.value.trim());
        if (k === 'focus') tr.classList.toggle('done', (t as HTMLInputElement).checked);
      });
      // un menu à cases se ferme quand on touche ailleurs
      const repaint = () => paint(root);
      document.addEventListener('click', closeMenus);
      window.addEventListener('online', repaint); window.addEventListener('offline', repaint);
      return () => { document.removeEventListener('click', closeMenus); window.removeEventListener('online', repaint); window.removeEventListener('offline', repaint); };   // nettoyage à la sortie de la page
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
