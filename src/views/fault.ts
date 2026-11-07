import type { ViewFactory } from '../router';
import { addFaultNote, can, editFault, resolveFault, state, view } from '../store';
import { esc, fmtDateTime } from '../logic';
import { describe } from '../ref';

/** Fiche d'une panne : déclaration, infos ajoutées, modifications, résolution — chacune datée et signée. */
export const faultView: ViewFactory = ([id]) => ({
  mount(root) {
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      const f = view().faults.find((x) => x.id === id);
      if (!el || !f) return;
      if (el.dataset.act === 'note') {
        const t = window.prompt('Information à ajouter');
        if (t && t.trim()) void addFaultNote(id, t);
      } else if (el.dataset.act === 'edit') {
        const t = window.prompt('Modifier la description', f.description ?? '');
        if (t !== null && t.trim() && t.trim() !== (f.description ?? '')) void editFault(id, t);
      } else if (el.dataset.act === 'resolve') {
        const r = window.prompt('Résolution (facultatif)', '');
        if (r !== null) void resolveFault(id, r);
      }
    });
    paint(root);
  },
  update: paint
});

function paint(root: HTMLElement) {
  const id = location.hash.split('/')[2];
  const data = view();
  const f = data.faults.find((x) => x.id === id);
  if (!f) { root.innerHTML = '<div class="page"><a href="#/faults" class="sub">‹ Pannes</a><div class="card empty">Panne introuvable.</div></div>'; return; }
  const it = data.items.find((i) => i.id === f.item_id);
  const d = it ? describe(data, it) : null;
  const me = state.profile?.id;
  // modification : régisseur et au-dessus, ou le technicien qui a déclaré la panne (le serveur revérifie)
  const canEdit = can('regisseur') || (can('technicien') && (f.reported_by ? f.reported_by === me : !!f.pending));
  const log = data.faultLog.filter((l) => l.fault_id === f.id);
  type Row = { at: string; html: string };
  const rows: Row[] = [{ at: f.reported_at, html: `<b>Déclarée</b> par ${esc(f.reported_by_label ?? 'moi')}${f.pending ? ' <span class="pending">en attente</span>' : ''}` }];
  for (const l of log) rows.push({ at: l.at, html: l.kind === 'note'
    ? `<b>Info ajoutée</b> par ${esc(l.by_label ?? 'moi')}${l.pending ? ' <span class="pending">en attente</span>' : ''}<div class="quote">${esc(l.text)}</div>`
    : `<b>Description modifiée</b> par ${esc(l.by_label ?? 'moi')}${l.pending ? ' <span class="pending">en attente</span>' : ''}<div class="quote">${esc(l.text)}</div>${l.old_text ? `<div class="muted">avant : ${esc(l.old_text)}</div>` : ''}` });
  if (f.resolved_at) rows.push({ at: f.resolved_at, html: `<b>Résolue</b> par ${esc(f.resolved_by_label ?? '—')}${f.resolution ? `<div class="quote">${esc(f.resolution)}</div>` : ''}` });
  rows.sort((a, b) => (a.at < b.at ? -1 : 1));
  root.innerHTML = `<div class="page"><a href="#/faults" class="sub">‹ Pannes</a>
    <div class="card stack">
      <div class="row"><a class="num" href="#/item/${f.item_id}">${f.item_id}</a>
        <div class="grow"><h1>${esc(d?.model?.name ?? 'Projecteur')}</h1>
          <div class="sub">${f.resolved_at ? 'Résolue' : '<span class="warn">En cours</span>'}</div></div></div>
      <div class="t">${esc(f.description || 'Sans description')}</div>
      <div class="row wrap">
        ${can('technicien') ? '<button class="btn small" data-act="note">Ajouter une info</button>' : ''}
        ${canEdit ? '<button class="btn small" data-act="edit">Modifier la description</button>' : ''}
        ${!f.resolved_at && can('regisseur') ? '<button class="btn small primary" data-act="resolve">Résolue</button>' : ''}
      </div></div>
    <div class="card stack"><h2>Historique</h2>
      ${rows.map((r) => `<div class="sub"><span class="muted">${fmtDateTime(r.at)}</span> · ${r.html}</div>`).join('')}
    </div></div>`;
}
