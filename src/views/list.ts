import type { ViewFactory } from '../router';
import { view } from '../store';
import { counts, esc } from '../logic';
import { describe, norm } from '../ref';
import { STATUS_LABEL, STATUSES } from '../types';
import type { Status } from '../types';

// Les filtres survivent à la navigation (on revient de la fiche sur la même liste).
const f = { q: '', status: '' as '' | Status, type: '', model: '', mode: 'units' as 'units' | 'models' };

export const listView: ViewFactory = (_p, query) => ({
  mount(root) {
    if (query.get('status')) f.status = query.get('status') as Status;
    root.innerHTML = `<div class="page">
      <h1>Parc</h1>
      <div id="tiles" class="tiles"></div>
      <input id="q" type="search" placeholder="N°, modèle, lampe, type…" autocomplete="off" value="${esc(f.q)}">
      <div id="types" class="chips"></div>
      <div id="modes" class="chips"></div>
      <div id="results" class="list"></div></div>`;
    const q = root.querySelector<HTMLInputElement>('#q')!;
    q.addEventListener('input', () => { f.q = q.value; paint(root); });
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!el) return;
      const { act, v } = el.dataset;
      if (act === 'status') f.status = (f.status === v ? '' : v) as Status | '';
      if (act === 'type') { f.type = v ?? ''; f.model = ''; }
      if (act === 'mode') f.mode = v as 'units' | 'models';
      if (act === 'model') { f.model = v ?? ''; f.mode = 'units'; }
      if (act === 'clearmodel') f.model = '';
      paint(root);
    });
    paint(root);
  },
  update: paint
});

function paint(root: HTMLElement) {
  const data = view();
  const rows = data.items.map((i) => ({ i, d: describe(data, i), open: data.faults.some((x) => x.item_id === i.id && !x.resolved_at) }));
  const tokens = norm(f.q).split(/\s+/).filter(Boolean);
  const matchText = (r: (typeof rows)[number]) => {
    const h = norm(`${r.i.id} ${r.d.model?.name ?? ''} ${r.d.type?.name ?? ''} ${r.d.family?.name ?? ''} ${r.d.lamp?.name ?? ''}`);
    return tokens.every((t) => h.includes(t));
  };
  const base = rows.filter((r) => (!f.type || r.d.model?.type_id === f.type) && matchText(r));

  // compteurs (sur la recherche + type, avant filtre d'état)
  const c = counts(base.map((r) => r.i));
  root.querySelector('#tiles')!.innerHTML =
    `<button class="tile" data-act="status" data-v="" aria-pressed="${f.status === ''}"><b>${c.total}</b><span>Total</span></button>` +
    STATUSES.map((s) => `<button class="tile ${s}" data-act="status" data-v="${s}" aria-pressed="${f.status === s}"><b>${c[s]}</b><span>${STATUS_LABEL[s]}</span></button>`).join('');

  const usedTypes = data.types.filter((t) => data.models.some((m) => m.type_id === t.id && data.items.some((i) => i.model_id === m.id)));
  root.querySelector('#types')!.innerHTML =
    `<button class="chip" data-act="type" data-v="" aria-pressed="${f.type === ''}">Tous types</button>` +
    usedTypes.map((t) => `<button class="chip" data-act="type" data-v="${t.id}" aria-pressed="${f.type === t.id}">${esc(t.name)}</button>`).join('');

  const modelName = data.models.find((m) => m.id === f.model)?.name;
  root.querySelector('#modes')!.innerHTML =
    `<button class="chip" data-act="mode" data-v="units" aria-pressed="${f.mode === 'units'}">Projecteurs</button>` +
    `<button class="chip" data-act="mode" data-v="models" aria-pressed="${f.mode === 'models'}">Par modèle</button>` +
    (f.model ? `<button class="chip" data-act="clearmodel" aria-pressed="true">${esc(modelName)} ✕</button>` : '');

  const out = root.querySelector('#results')!;
  const withStatus = base.filter((r) => !f.status || r.i.status === f.status);

  if (f.mode === 'models') {
    const groups = new Map<string, typeof rows>();
    for (const r of withStatus) (groups.get(r.i.model_id) ?? groups.set(r.i.model_id, []).get(r.i.model_id)!).push(r);
    const list = [...groups.entries()].map(([id, rs]) => ({ id, rs, m: data.models.find((m) => m.id === id) }))
      .sort((a, b) => (a.m?.name ?? '').localeCompare(b.m?.name ?? '', 'fr', { numeric: true }));
    out.innerHTML = list.length ? list.map(({ id, rs, m }) => {
      const k = counts(rs.map((r) => r.i));
      const type = data.types.find((t) => t.id === m?.type_id)?.name ?? '';
      return `<button class="item" data-act="model" data-v="${id}">
        <div class="grow"><div class="t">${esc(m?.name)}</div><div class="s">${esc(type)}</div></div>
        <div class="s" style="text-align:right"><b style="font-size:1.1rem;color:var(--ink)">${k.total}</b><br>
          <span class="cnt" title="Disponibles">${k.dispo}</span> · <span class="cnt ${k.sav ? 'sav' : ''}" title="SAV">${k.sav}</span> · <span class="cnt ${k.en_pret ? 'en_pret' : ''}" title="En prêt">${k.en_pret}</span></div></button>`;
    }).join('') : `<div class="empty">Aucun résultat</div>`;
    return;
  }

  const shown = withStatus.filter((r) => !f.model || r.i.model_id === f.model);
  out.innerHTML = shown.length ? shown.map((r) => `
    <a class="item" href="#/item/${r.i.id}">
      <div class="num">${r.i.id}</div>
      <div class="grow"><div class="t">${esc(r.d.model?.name)}${r.open ? '<span class="dot" title="Panne en cours"></span>' : ''}</div>
        <div class="s">${esc([r.d.type?.name, r.d.lamp?.name].filter(Boolean).join(' · '))}${r.i.pending ? ' <span class="pending">en attente</span>' : ''}</div></div>
      <span class="badge ${r.i.status}">${STATUS_LABEL[r.i.status]}</span>
    </a>`).join('') : `<div class="empty">Aucun projecteur ne correspond</div>`;
}
