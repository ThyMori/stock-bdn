import type { ViewFactory } from '../router';
import { can, resolveFault, view } from '../store';
import { esc, fmtDate, fmtDateTime } from '../logic';
import { describe } from '../ref';

let showClosed = false;

export const faultsView: ViewFactory = () => ({
  mount(root) {
    root.innerHTML = `<div class="page"><h1>Pannes</h1>
      <div class="chips"><button class="chip" data-act="open">En cours</button><button class="chip" data-act="closed">Résolues</button></div>
      <div id="list" class="list"></div></div>`;
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!el) return;
      if (el.dataset.act === 'open') showClosed = false;
      else if (el.dataset.act === 'closed') showClosed = true;
      else if (el.dataset.act === 'resolve') {
        const r = window.prompt('Résolution (facultatif)', '');
        if (r !== null) void resolveFault(el.dataset.v!, r);
        return;
      }
      paint(root);
    });
    paint(root);
  },
  update: paint
});

function paint(root: HTMLElement) {
  const data = view();
  const chips = root.querySelectorAll<HTMLElement>('.chip');
  chips[0].setAttribute('aria-pressed', String(!showClosed));
  chips[1].setAttribute('aria-pressed', String(showClosed));
  const list = data.faults.filter((f) => !!f.resolved_at === showClosed)
    .sort((a, b) => (showClosed ? (b.resolved_at ?? '') > (a.resolved_at ?? '') : b.reported_at > a.reported_at) ? 1 : -1);
  const tech = can('technicien');
  root.querySelector('#list')!.innerHTML = list.length ? list.map((f) => {
    const it = data.items.find((i) => i.id === f.item_id);
    const d = it ? describe(data, it) : null;
    return `<div class="item">
      <a class="num" href="#/item/${f.item_id}">${f.item_id}</a>
      <div class="grow"><div class="t">${esc(f.description || 'Sans description')}${f.pending ? ' <span class="pending">en attente</span>' : ''}</div>
        <div class="s">${esc(d?.model?.name ?? '')} · ${esc(f.reported_by_label ?? 'moi')} · ${fmtDateTime(f.reported_at)}${f.resolved_at ? ` · résolue le ${fmtDate(f.resolved_at)}` : ''}</div></div>
      ${!showClosed && tech ? `<button class="btn small" data-act="resolve" data-v="${f.id}">Résolue</button>` : ''}</div>`;
  }).join('') : `<div class="empty">${showClosed ? 'Aucune panne résolue.' : 'Aucune panne en cours 🎉'}</div>`;
}
