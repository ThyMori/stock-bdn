import type { ViewFactory } from '../router';
import { view } from '../store';
import { counts, esc, currentImmo, immoState, todayStr } from '../logic';
import { fmtDay } from './agenda';
import { describe, norm } from '../ref';
import { STATUS_LABEL, STATUSES } from '../types';
import type { Status } from '../types';

// Les filtres survivent à la navigation (on revient de la fiche sur la même liste).
const store = { get: (): string | null => { try { return localStorage.getItem('stockbdn.chart'); } catch { return null; } },
  set: (v: string) => { try { localStorage.setItem('stockbdn.chart', v); } catch { /* stockage indisponible : sans conséquence */ } } };
const f = { chart: store.get() === 'pie', q: '', status: '' as '' | Status, type: '', model: '', mode: 'units' as 'units' | 'models' };

export const listView: ViewFactory = (_p, query) => ({
  mount(root) {
    if (query.get('status')) f.status = query.get('status') as Status;
    root.innerHTML = `<div class="page">
      <div class="row"><h1 class="grow">Parc</h1>
        <div class="chips" role="group" aria-label="Affichage des compteurs">
          <button class="chip" data-act="chart" data-v="tiles" title="Afficher en cases">Cases</button>
          <button class="chip" data-act="chart" data-v="pie" title="Afficher en camembert">Camembert</button></div></div>
      <div id="tiles"></div>
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
      if (act === 'chart') { f.chart = v === 'pie'; store.set(v ?? 'tiles'); }
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

/** Camembert SVG en perspective (vue inclinée, avec épaisseur) : toucher une part filtre la liste, comme les cases. */
function pieSvg(c: { total: number; dispo: number; sav: number; en_pret: number }, sel: '' | Status): string {
  const CX = 150, CY = 78, RX = 128, RY = 58, DEPTH = 26;       // RY/RX = inclinaison ; DEPTH = épaisseur
  const top = (a: number, dy = 0) => `${(CX + RX * Math.cos(a)).toFixed(1)} ${(CY + RY * Math.sin(a) + dy).toFixed(1)}`;
  const parts = STATUSES.filter((s) => c[s] > 0);
  let a0 = -Math.PI / 2;
  const walls: string[] = [], tops: string[] = [];
  for (const s of parts) {
    const frac = c[s] / c.total, a1 = a0 + frac * Math.PI * 2, mid = (a0 + a1) / 2;
    const pull = sel === s ? 9 : 0;
    const tr = pull ? ` transform="translate(${(Math.cos(mid) * pull).toFixed(1)} ${(Math.sin(mid) * pull * RY / RX).toFixed(1)})"` : '';
    // épaisseur : seule la moitié avant (angles 0 → π) est visible
    const s0 = Math.max(a0, 0), e0 = Math.min(a1, Math.PI);
    let wall = '';
    if (e0 > s0) {
      const n = Math.max(2, Math.ceil(((e0 - s0) / Math.PI) * 40)); const up: string[] = [], down: string[] = [];
      for (let i = 0; i <= n; i++) { const a = s0 + ((e0 - s0) * i) / n; up.push(top(a)); down.unshift(top(a, DEPTH)); }
      wall = `<path class="wall ${s}" d="M ${up.join(' L ')} L ${down.join(' L ')} Z"${tr}/><path class="shade" d="M ${up.join(' L ')} L ${down.join(' L ')} Z"${tr}/>`;
    }
    walls.push(wall);
    const d = frac >= 0.9999
      ? `M ${top(-Math.PI / 2)} A ${RX} ${RY} 0 1 1 ${top(Math.PI / 2)} A ${RX} ${RY} 0 1 1 ${top(-Math.PI / 2)} Z`
      : `M ${CX} ${CY} L ${top(a0)} A ${RX} ${RY} 0 ${frac > 0.5 ? 1 : 0} 1 ${top(a1)} Z`;
    tops.push(`<path class="slice ${s}" data-act="status" data-v="${s}" d="${d}"${tr}><title>${STATUS_LABEL[s]} : ${c[s]}</title></path>`);
    a0 = a1;
  }
  // les parts dont le flanc est au premier plan sont dessinées en dernier
  const body = c.total
    ? `<ellipse cx="${CX}" cy="${CY + DEPTH + 6}" rx="${RX}" ry="${RY * 0.9}" class="ground"/>${walls.join('')}${tops.join('')}`
    : `<ellipse cx="${CX}" cy="${CY}" rx="${RX}" ry="${RY}" class="slice empty"/>`;
  return `<svg class="pie-svg" viewBox="0 0 300 ${CY + RY + DEPTH + 22}" role="img" aria-label="Répartition du parc par état">${body}</svg>`;
}

function paint(root: HTMLElement) {
  const data = view();
  const today = todayStr();
  const rows = data.items.map((i) => ({ i, im: i.status === 'dispo' ? undefined : currentImmo(data.immos, i.id, today), d: describe(data, i), open: data.faults.some((x) => x.item_id === i.id && !x.resolved_at) }));
  const tokens = norm(f.q).split(/\s+/).filter(Boolean);
  const matchText = (r: (typeof rows)[number]) => {
    const h = norm(`${r.i.id} ${r.d.model?.name ?? ''} ${r.d.type?.name ?? ''} ${r.d.family?.name ?? ''} ${r.d.lamp?.name ?? ''}`);
    return tokens.every((t) => h.includes(t));
  };
  const base = rows.filter((r) => (!f.type || r.d.model?.type_id === f.type) && matchText(r));

  // compteurs (sur la recherche + type, avant filtre d'état)
  const c = counts(base.map((r) => r.i));
  const tilesEl = root.querySelector('#tiles')!;
  const toggles = root.querySelectorAll<HTMLElement>('[data-act="chart"]');
  toggles[0].setAttribute('aria-pressed', String(!f.chart)); toggles[1].setAttribute('aria-pressed', String(f.chart));
  if (!f.chart) {
    tilesEl.className = 'tiles';
    tilesEl.innerHTML =
      `<button class="tile" data-act="status" data-v="" aria-pressed="${f.status === ''}"><b>${c.total}</b><span>Total</span></button>` +
      STATUSES.map((s) => `<button class="tile ${s === 'en_pret' && !c[s] ? '' : s}" data-act="status" data-v="${s}" aria-pressed="${f.status === s}"><b>${c[s]}</b><span>${STATUS_LABEL[s]}</span></button>`).join('');
  } else {
    tilesEl.className = 'pie';
    tilesEl.innerHTML = pieSvg(c, f.status) + `<div class="legend">` +
      `<button class="lg" data-act="status" data-v="" aria-pressed="${f.status === ''}"><i style="background:var(--ink)"></i><span>Total</span><b>${c.total}</b><em></em></button>` +
      STATUSES.map((s) => `<button class="lg" data-act="status" data-v="${s}" aria-pressed="${f.status === s}"><i class="${s}"></i><span>${STATUS_LABEL[s]}</span><b>${c[s]}</b><em>${c.total ? Math.round((c[s] / c.total) * 100) : 0} %</em></button>`).join('') + `</div>`;
  }

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
          <span class="cnt ${k.dispo ? 'dispo' : ''}" title="Disponibles">${k.dispo}</span> · <span class="cnt ${k.sav ? 'sav' : ''}" title="SAV">${k.sav}</span> · <span class="cnt ${k.en_pret ? 'en_pret' : ''}" title="En prêt">${k.en_pret}</span></div></button>`;
    }).join('') : `<div class="empty">Aucun résultat</div>`;
    return;
  }

  const shown = withStatus.filter((r) => !f.model || r.i.model_id === f.model);
  out.innerHTML = shown.length ? shown.map((r) => `
    <a class="item" href="#/item/${r.i.id}">
      <div class="num">${r.i.id}</div>
      <div class="grow"><div class="t">${esc(r.d.model?.name)}${r.open ? '<span class="dot" title="Panne en cours"></span>' : ''}</div>
        <div class="s">${esc([r.d.type?.name, r.d.lamp?.name].filter(Boolean).join(' · '))}${r.i.pending ? ' <span class="pending">en attente</span>' : ''}${r.im ? `<br>${r.im.kind === 'pret' ? 'Prêté' + (r.im.who ? ' à ' + esc(r.im.who) : '') : 'SAV'}${r.im.end_date ? ' · ' + (r.im.kind === 'pret' ? 'retour' : 'fin') + ' ' + fmtDay(r.im.end_date) : ''}${immoState(r.im, today) === 'late' ? ' <span class="tag late">en retard</span>' : ''}` : ''}</div></div>
      <span class="badge ${r.i.status}">${STATUS_LABEL[r.i.status]}</span>
    </a>`).join('') : `<div class="empty">Aucun projecteur ne correspond</div>`;
}
