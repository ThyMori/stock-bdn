import { GEL_COLORS } from './types';
import type { Data } from './types';
import { describe } from './ref';
import { appReference } from './pdfHeader';
import { patchPosition, positionBefore } from './position';
import type { Show } from './types';
import { ACCESSORIES, buildRows, labelsOf } from './patch';
import { accessoryList } from './patchLists';

const DAY = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);

/** Provenance d'un projecteur à préparer : stock des dessous, stock du 3e (pastille bleue) ou déjà monté dans le spectacle d'avant. */
export type Origin = 'dessous' | 'stock3' | 'monte';
/** Titres des deux parties de la liste : à sortir du stock, et déjà en place sur le spectacle précédent. */
export const PREP_TITLE = { prep: 'À préparer', monte: 'Présents sur le spectacle précédent' };
export const ORIGIN_TITLE: Record<Origin, string> = { dessous: 'Stock dessous', stock3: 'Stock 3e (pastille bleue)', monte: 'Déjà monté (spectacle précédent)' };
export interface PrepRow { id: number; model: string; type: string; lamp: string; current: string; sav: boolean; gels: string[];
  origin: Origin; /** stockage normal : dessous, ou 3e (pastille bleue) */ storage: 'dessous' | 'stock3'; /** d'où il vient (« P2 (Avant) », « stock 3e »…) */ from: string; /** position prévue sur la feuille de patch */ position: string; accessories: string[] }
export interface GelGroup { title: string; size: string; color: string; ref: string; qty: number; items: number[] }

// classement par référence : Lee (L, LEE) avant Rosco (R, #), puis par numéro (106 avant 201), puis par le reste du texte
const refKey = (ref: string): [number, number, string] => {
  const m = ref.toLowerCase().replace(/\s+/g, '').match(/^(lee|l|rosco|roscolux|rosc|r|#)?(\d+)(.*)$/);
  if (!m) return [2, 0, ref.toLowerCase()];                              // référence inhabituelle : à la fin, par ordre alphabétique
  return [!m[1] || m[1] === 'lee' || m[1] === 'l' ? 0 : 1, Number(m[2]), m[3]];
};
export const byRef = (a: string, b: string): number => { const x = refKey(a), y = refKey(b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2], 'fr'); };

/** Gélatines du spectacle : une section par « format de projecteur » (PAR64, 613 SX / 614 SX…).
 *  Les modèles qui ont la même taille de porte-filtre sont regroupés dans une même section ; sans taille connue, un modèle = une section.
 *  Dans chaque section : couleur la plus proche, puis référence. */
export function gelGroups(data: Data, showId: string): GelGroup[] {
  const sizeOfModel = (modelId: string | null | undefined) => data.filterSizes.find((f) => f.id === data.models.find((m) => m.id === modelId)?.filter_size_id)?.label ?? '';
  // une « cellule » = un modèle + une référence : nombre de gels posés sur des projecteurs / lignes de patch (phys) et nombre demandé sur les demandes (req)
  interface Cell { model: string; size: string; key: string; color: string; ref: string; phys: number; req: number; items: number[] }
  const cells = new Map<string, Cell>();
  const cell = (model: string, size: string, color: string, ref: string): Cell => {
    const k = [model, color, ref.trim().toLowerCase()].join('|');
    let c = cells.get(k);
    if (!c) { c = { model, size, key: size || 'm:' + model, color, ref: ref.trim(), phys: 0, req: 0, items: [] }; cells.set(k, c); }
    return c;
  };
  for (const g of data.showGels.filter((x) => x.show_id === showId)) {
    const it = data.items.find((i) => i.id === g.item_id);
    const d = it ? describe(data, it) : null;
    const c = cell(d?.model?.name ?? '?', d?.filter?.label ?? '', g.color, g.ref); c.phys++; c.items.push(g.item_id);
  }
  // lignes de la feuille de patch sans projecteur (location, prêt, à louer) : leurs gélatines comptent aussi (modèle indiqué, pas de numéro)
  for (const l of data.patchLines.filter((x) => x.show_id === showId && x.item_id === null)) {
    const model = data.models.find((m) => m.id === l.model_id)?.name ?? (l.model_text || 'Sans modèle');
    for (const g of l.gels ?? []) cell(model, sizeOfModel(l.model_id), g.color, g.ref).phys++;
  }
  // gélatines demandées sur les demandes (sans n°) : jamais plus que la quantité demandée ; fusionnées avec les gels posés = le plus grand des deux
  for (const dg of (data.showDemandGels ?? []).filter((x) => x.show_id === showId)) {
    const dm = data.showDemands.find((x) => x.id === dg.demand_id), m = data.models.find((x) => x.id === dm?.model_id);
    if (!dm || !m) continue;
    cell(m.name, sizeOfModel(m.id), dg.color, dg.ref).req += Math.min(dg.qty, dm.qty);
  }
  const models = new Map<string, Set<string>>();
  for (const c of cells.values()) { const m = models.get(c.key) ?? new Set<string>(); m.add(c.model); models.set(c.key, m); }
  const titleOf = (k: string) => [...(models.get(k) ?? [])].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true })).join(' / ');
  const map = new Map<string, GelGroup>();
  for (const c of cells.values()) {
    const key = [c.key, c.color, c.ref.toLowerCase()].join('|');
    const cur = map.get(key) ?? { title: titleOf(c.key), size: c.size, color: c.color, ref: c.ref, qty: 0, items: [] };
    cur.qty += Math.max(c.phys, c.req); cur.items.push(...c.items); map.set(key, cur);
  }
  return [...map.values()].filter((g) => g.qty > 0).map((g) => ({ ...g, items: [...g.items].sort((a, b) => a - b) }))
    .sort((a, b) => a.title.localeCompare(b.title, 'fr', { numeric: true }) || byRef(a.ref, b.ref));
}

export interface HolderRow { model: string; size: string; qty: number }
/** Porte-filtres à préparer, par modèle de projecteur. Un projecteur qui a 1 ou 2 gels n'utilise qu'UN porte-filtre.
 *  Par modèle : le plus grand de (projecteurs réellement gélatinés : affectés, ou lignes de patch sans projecteur) et
 *  (côté demandes, le plus grand nombre demandé pour une référence : on suppose les gels sur les mêmes projecteurs). */
export function holderRows(data: Data, showId: string): HolderRow[] {
  const sizeOf = (modelId: string | null | undefined) => data.filterSizes.find((f) => f.id === data.models.find((m) => m.id === modelId)?.filter_size_id)?.label ?? '';
  const by = new Map<string, { size: string; items: Set<number>; lines: number; req: Map<string, number> }>();
  const get = (model: string, size: string) => { let e = by.get(model); if (!e) { e = { size, items: new Set(), lines: 0, req: new Map() }; by.set(model, e); } return e; };
  for (const g of data.showGels.filter((x) => x.show_id === showId)) {
    const it = data.items.find((i) => i.id === g.item_id), d = it ? describe(data, it) : null;
    get(d?.model?.name ?? '?', d?.filter?.label ?? '').items.add(g.item_id);
  }
  for (const l of data.patchLines.filter((x) => x.show_id === showId && x.item_id === null && (x.gels ?? []).length)) {
    get(data.models.find((m) => m.id === l.model_id)?.name ?? (l.model_text || 'Sans modèle'), sizeOf(l.model_id)).lines++;
  }
  for (const dg of (data.showDemandGels ?? []).filter((x) => x.show_id === showId)) {
    const dm = data.showDemands.find((x) => x.id === dg.demand_id), m = data.models.find((x) => x.id === dm?.model_id);
    if (!dm || !m) continue;
    const e = get(m.name, sizeOf(m.id)), k = dg.ref.trim().toLowerCase();
    e.req.set(k, (e.req.get(k) ?? 0) + Math.min(dg.qty, dm.qty));
  }
  return [...by].map(([model, e]) => ({ model, size: e.size, qty: Math.max(e.items.size + e.lines, ...e.req.values(), 0) })).filter((r) => r.qty > 0)
    .sort((a, b) => a.model.localeCompare(b.model, 'fr', { numeric: true }));
}

export interface GelRef { ref: string; color: string; total: number; rows: { title: string; size: string; qty: number }[] }
/** Gélatines à couper dans l'ordre de travail du technicien : d'abord par référence (il sort un rouleau), puis, pour chaque référence, par format / modèle de projecteur. */
export function gelsByRef(data: Data, showId: string): GelRef[] {
  const m = new Map<string, GelRef>();
  for (const g of gelGroups(data, showId)) {
    const key = g.ref.toLowerCase().replace(/\s+/g, '') + '|' + g.color;
    const e = m.get(key) ?? { ref: g.ref, color: g.color, total: 0, rows: [] };
    e.total += g.qty; e.rows.push({ title: g.title, size: g.size, qty: g.qty }); m.set(key, e);
  }
  return [...m.values()].map((e) => ({ ...e, rows: e.rows.sort((a, b) => a.title.localeCompare(b.title, 'fr', { numeric: true })) })).sort((a, b) => byRef(a.ref, b.ref));
}

/** Provenance, position prévue et accessoires (feuille de patch) d'un projecteur du spectacle. */
function originOf(data: Data, show: Show | undefined, itemId: number): Pick<PrepRow, 'origin' | 'storage' | 'from' | 'position' | 'accessories'> {
  if (!show) return { origin: 'dessous', storage: 'dessous', from: 'stock dessous', position: '', accessories: [] };
  const p = positionBefore(data, itemId, show);
  const line = data.patchLines.find((l) => l.show_id === show.id && l.item_id === itemId);
  const origin: Origin = p.kind === 'show' ? 'monte' : p.kind === 'stock3' ? 'stock3' : 'dessous';
  const storage: PrepRow['storage'] = origin === 'stock3' || (origin === 'monte' && data.items.find((i) => i.id === itemId)?.blue_dot) ? 'stock3' : 'dessous';   // stockage normal : 3e si pastille bleue
  return { origin, storage, from: p.kind === 'show' ? `${p.position || '?'} (${p.show})` : p.kind === 'stock3' ? 'stock 3e' : 'stock dessous', position: patchPosition(data, show.id, itemId), accessories: line?.accessories ?? [] };
}

/** Prêts / locations du spectacle : « 4 × PAR64 CP62 prêtés par X », dates, et accessoires cumulés des lignes de patch rattachées. */
export function externalRows(data: Data, showId: string): { kind: 'pret' | 'location'; text: string; dates: string; accessories: string[] }[] {
  const lamp = (id: string | null) => data.lamps.find((l) => l.id === id)?.name ?? '';
  return data.showExternals.filter((e) => e.show_id === showId).sort((a, b) => a.delivery_date.localeCompare(b.delivery_date)).map((e) => {
    const d = data.showDemands.find((x) => x.id === e.demand_id), m = data.models.find((x) => x.id === d?.model_id)?.name ?? '?', l = lamp(d?.lamp_id ?? null);
    const acc = new Map<string, number>();
    for (const ln of data.patchLines.filter((x) => x.show_id === showId && x.external_id === e.id)) for (const a of ln.accessories) acc.set(a, (acc.get(a) ?? 0) + 1);
    return { kind: e.kind, text: `${e.qty} × ${m}${l ? ' ' + l : ''} — ${e.kind === 'pret' ? 'prêté par' : 'loué chez'} ${e.provider}`,
      dates: `livraison ${DAY(e.delivery_date)}, reprise ${DAY(e.return_date)}`, accessories: [...acc].map(([a, n]) => (n > 1 ? `${n} × ` : '') + a) };
  });
}

/** Lignes de la liste de prépa : projecteurs du spectacle, triés par type, modèle puis numéro. */
export function prepRows(data: Data, showId: string): PrepRow[] {
  const show = data.shows.find((x) => x.id === showId);
  const name = (id: string | null | undefined) => data.lamps.find((l) => l.id === id)?.name ?? '';
  return data.showItems.filter((s) => s.show_id === showId).map((s) => {
    const it = data.items.find((i) => i.id === s.item_id);
    const d = it ? describe(data, it) : null;
    const isPar = /^PAR/i.test(d?.type?.name ?? '');
    return { id: s.item_id, model: d?.model?.name ?? '?', type: d?.type?.name ?? 'Sans type',
      lamp: isPar ? name(s.lamp_id) || 'à préciser' : '', current: isPar && it ? name(it.lamp_id) : '', sav: !!it && it.status === 'sav',
      gels: data.showGels.filter((g) => g.show_id === showId && g.item_id === s.item_id).map((g) => g.ref).sort(),
      ...originOf(data, show, s.item_id) };
  }).sort((a, b) => a.type.localeCompare(b.type, 'fr') || a.model.localeCompare(b.model, 'fr', { numeric: true }) || a.id - b.id);
}

/** Les deux parties de la liste : « À préparer » (à sortir du stock) et « Présents sur le spectacle précédent » (déjà en place).
 *  Dans chaque partie : un groupe par modèle, et dans le groupe le stock dessous avant le stock 3e, puis par numéro. */
export function prepSections(rows: PrepRow[]): { key: 'prep' | 'monte'; title: string; groups: { model: string; rows: PrepRow[] }[] }[] {
  const group = (list: PrepRow[]) => [...new Set(list.map((r) => r.model))].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }))
    .map((model) => ({ model, rows: list.filter((r) => r.model === model).sort((a, b) => Number(a.storage === 'stock3') - Number(b.storage === 'stock3') || a.id - b.id) }));
  const prep = rows.filter((r) => r.origin !== 'monte'), monte = rows.filter((r) => r.origin === 'monte');
  return [{ key: 'prep' as const, title: PREP_TITLE.prep, groups: group(prep) }, { key: 'monte' as const, title: PREP_TITLE.monte, groups: group(monte) }].filter((x) => x.groups.length);
}

/** Contexte de dessin partagé entre les PDF (prépa, démontage) : le document, les marges, la position courante et le saut de page. */
export interface PdfCtx { doc: import('jspdf').jsPDF; M: number; W: number; y: number; ensure: (h: number) => void }

/** Section « Gélatines à couper » d'un spectacle (par format de projecteur, lignes sans projecteur comprises). Dessine à la suite de ce qui est déjà écrit : `ctx.y` est la position courante, `ctx.ensure(h)` saute de page s'il manque de la place. */
export function drawGelSection(ctx: PdfCtx, data: Data, showId: string, sub = ''): void {
  const { doc, M, W } = ctx;
  let y = ctx.y;
  const ensure = (h: number) => { ctx.y = y; ctx.ensure(h); y = ctx.y; };   // le saut de page remet y en haut
  // gélatines : une référence après l'autre (un rouleau à la fois), avec en dessous les formats / modèles à couper dans cette référence
  const refs = gelsByRef(data, showId);
  if (refs.length) {
    ensure(30); y += 8;
    doc.setFillColor(20, 20, 20); doc.rect(M, y - 4.5, W - 2 * M, 7, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(`Gélatines à couper  (${refs.reduce((n, r) => n + r.total, 0)})`, M + 2, y); if (sub) { doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(sub, W - M - 2, y, { align: 'right' }); } doc.setTextColor(0);
    y += 7;
    for (const r of refs) {
      ensure(8 + Math.min(r.rows.length, 3) * 6); y += 2;
      const hex = GEL_COLORS.find(([n]) => n === r.color)?.[1] ?? '#8d6e63';
      doc.setDrawColor(0); doc.setLineWidth(0.3); doc.rect(M + 2, y - 3.4, 4, 4);   // case à cocher : rouleau sorti
      doc.setFillColor(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)); doc.setLineWidth(0.2); doc.rect(M + 9, y - 3.4, 4, 4, 'FD');
      doc.setTextColor(0); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(r.ref, M + 16, y, { maxWidth: 60 });
      doc.setFontSize(10); doc.text(`x ${r.total}`, M + 80, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110); doc.text(r.color, W - M - 2, y, { align: 'right' }); doc.setTextColor(0);
      doc.setDrawColor(0); doc.setLineWidth(0.2); doc.line(M, y + 1.8, W - M, y + 1.8); y += 6.5;
      for (const row of r.rows) {   // formats / modèles de cette référence
        ensure(7);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(row.title, M + 16, y, { maxWidth: 70 });
        if (row.size) { doc.setFontSize(8); doc.setTextColor(110); doc.text(`(${row.size})`, M + 90, y); doc.setTextColor(0); }
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(`x ${row.qty}`, M + 120, y);
        doc.setDrawColor(200); doc.setLineWidth(0.1); doc.line(M + 16, y + 2.2, W - M, y + 2.2);
        y += 6;
      }
    }
  }
  ctx.y = y;
}

/** Section « Porte-filtres à préparer » : un porte-filtre par projecteur gélatiné, nommé par son modèle (la taille en gris). */
export function drawHolderSection(ctx: PdfCtx, data: Data, showId: string, sub = ''): void {
  const { doc, M, W } = ctx;
  let y = ctx.y;
  const ensure = (h: number) => { ctx.y = y; ctx.ensure(h); y = ctx.y; };   // le saut de page remet y en haut
  const rows = holderRows(data, showId);
  if (rows.length) {
    ensure(30); y += 8;
    doc.setFillColor(20, 20, 20); doc.rect(M, y - 4.5, W - 2 * M, 7, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(`Porte-filtres à préparer  (${rows.reduce((n, r) => n + r.qty, 0)})`, M + 2, y);
    if (sub) { doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(sub, W - M - 2, y, { align: 'right' }); } doc.setTextColor(0);
    y += 7;
    for (const r of rows) {
      ensure(9);
      doc.setDrawColor(0); doc.setLineWidth(0.3); doc.rect(M + 6, y - 3.4, 4, 4);   // case à cocher : porte-filtres préparés
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(r.model, M + 14, y, { maxWidth: 70 }); doc.text(`x ${r.qty}`, M + 90, y);
      if (r.size) { doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110); doc.text(`(${r.size})`, M + 106, y); doc.setTextColor(0); }
      doc.setDrawColor(200); doc.setLineWidth(0.1); doc.line(M, y + 2.2, W - M, y + 2.2);
      y += 7;
    }
  }
  ctx.y = y;
}

/** Section « Accessoires à préparer » d'un spectacle (par modèle, avec les numéros de projecteurs). Dessine à la suite de ce qui est déjà écrit : `ctx.y` est la position courante, `ctx.ensure(h)` saute de page s'il manque de la place. */
export function drawAccessorySection(ctx: PdfCtx, data: Data, showId: string, sub = ''): void {
  const { doc, M, W } = ctx;
  let y = ctx.y;
  const ensure = (h: number) => { ctx.y = y; ctx.ensure(h); y = ctx.y; };   // le saut de page remet y en haut
  // accessoires à préparer : par modèle, avec les numéros des projecteurs concernés (feuille de patch, lignes sans projecteur comprises)
  const acc = accessoryList(buildRows(data, showId, data.patchLines));
  if (acc.length) {
    ensure(30); y += 8;
    doc.setFillColor(20, 20, 20); doc.rect(M, y - 4.5, W - 2 * M, 7, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(`Accessoires à préparer  (${acc.reduce((n, a) => n + a.qty, 0)})`, M + 2, y); if (sub) { doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(sub, W - M - 2, y, { align: 'right' }); } doc.setTextColor(0);
    y += 7; let lastModel = '';
    for (const a of acc) {
      if (a.model !== lastModel) {
        ensure(18); if (lastModel) y += 3; doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(a.model, M + 2, y);
        doc.setDrawColor(0); doc.setLineWidth(0.2); doc.line(M, y + 1.8, W - M, y + 1.8); y += 7; lastModel = a.model;
      }
      ensure(9);
      doc.setDrawColor(0); doc.setLineWidth(0.3); doc.rect(M + 6, y - 3.4, 4, 4);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(`${a.accessory}`, M + 14, y); doc.text(`x ${a.qty}`, M + 50, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(90); doc.text(`n° ${a.ids}`, M + 66, y, { maxWidth: W - M - (M + 66) }); doc.setTextColor(0);
      doc.setDrawColor(200); doc.setLineWidth(0.1); doc.line(M, y + 2.2, W - M, y + 2.2);
      y += 7;
    }
  }
  ctx.y = y;
}

/** Génère le PDF (jsPDF chargé à la demande pour ne pas alourdir l'appli). */
export async function buildPrepPdf(data: Data, showId: string, now = new Date()): Promise<{ blob: Blob; filename: string }> {
  const show = data.shows.find((s) => s.id === showId);
  if (!show) throw new Error('Spectacle introuvable');
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 15, H = 297;
  const rows = prepRows(data, showId);
  const regs = data.showRegisseurs.filter((r) => r.show_id === showId).map((r) => r.label).filter(Boolean).join(', ');
  let y = M;
  const footer = () => {
    const n = doc.getNumberOfPages();
    for (let p = 1; p <= n; p++) { doc.setPage(p); appReference(doc, W, M); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
      doc.text(`Liste de prépa - ${show.name}`, M, H - 8); doc.text(`Page ${p} / ${n}`, W - M, H - 8, { align: 'right' }); }
  };
  const ensure = (h: number) => { if (y + h > H - 16) { doc.addPage(); y = M; } };

  doc.setTextColor(0); doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('Liste de prépa', M, y + 6);
  doc.setFontSize(14); y += 14; doc.text(show.name, M, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); y += 6;
  doc.text(`Du ${DAY(show.start_date)} au ${DAY(show.end_date)}`, M, y); y += 5;
  if (regs) { doc.text(`Régie : ${regs}`, M, y); y += 5; }
  doc.setTextColor(110); doc.text(`Générée le ${DAY(now.toISOString())} - ${rows.length} projecteur${rows.length > 1 ? 's' : ''}`, M, y); doc.setTextColor(0); y += 4;

  const miss = data.showDemands.filter((x) => x.show_id === showId && x.missing > 0);
  if (miss.length) {
    y += 3; doc.setTextColor(200, 0, 0); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    const txt = 'ATTENTION - matériel manquant : ' + miss.map((x) => `${x.missing} x ${data.models.find((m) => m.id === x.model_id)?.name ?? '?'}${x.lamp_id ? ' ' + (data.lamps.find((l) => l.id === x.lamp_id)?.name ?? '') : ''}${x.zone ? ' (' + x.zone + ')' : ''}`).join(', ');
    doc.text(txt, M, y, { maxWidth: W - 2 * M }); y += 5 * Math.ceil(doc.getTextWidth(txt) / (W - 2 * M)); doc.setTextColor(0); doc.setFont('helvetica', 'normal');
  }
  const exts = externalRows(data, showId);
  // récapitulatif par type
  const types = [...new Set(rows.map((r) => r.type))];
  if (types.length) {
    y += 3; doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text('Récapitulatif', M, y); doc.setFont('helvetica', 'normal'); y += 5;
    doc.text(types.map((t) => `${t} : ${rows.filter((r) => r.type === t).length}`).join('   '), M, y, { maxWidth: W - 2 * M });
    y += 5 * Math.ceil(doc.getTextWidth(types.map((t) => `${t} : ${rows.filter((r) => r.type === t).length}`).join('   ')) / (W - 2 * M)) + 2;
  }
  if (!rows.length) { y += 8; doc.text('Aucun projecteur assigné à ce spectacle.', M, y); }

  // sections par provenance (dessous, 3e, déjà monté), puis par type dans chaque section
  const bar = (title: string, n: number, blue = false) => {
    ensure(24); y += 5;
    if (blue) doc.setFillColor(29, 107, 255); else doc.setFillColor(20, 20, 20); doc.rect(M, y - 4.5, W - 2 * M, 7, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(`${title}  (${n})`, M + 2, y); doc.setTextColor(0); y += 6;
  };
  for (const sec of prepSections(rows)) {
    bar(sec.title, sec.groups.reduce((n, g) => n + g.rows.length, 0));
    for (const g of sec.groups) {
      ensure(20); doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(90);
      doc.text(`${g.model.toUpperCase()}  (${g.rows.length})`, M + 2, y); doc.setFont('helvetica', 'normal');
      doc.text('N°', M + 24, y); doc.text('STOCK', M + 40, y); doc.text('LAMPE REQUISE', M + 75, y); doc.text('REMARQUE', M + 118, y);
      doc.setTextColor(0); doc.setLineWidth(0.2); doc.setDrawColor(0); doc.line(M, y + 1.5, W - M, y + 1.5); y += 6;
      for (const r of g.rows) {
        ensure(11);
        doc.setDrawColor(0); doc.setLineWidth(0.3); doc.rect(M + 6, y - 3.4, 4, 4);       // case à cocher
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(String(r.id), M + 24, y);
        doc.setFontSize(10); if (r.storage === 'stock3') doc.setTextColor(29, 107, 255);   // stock 3e en bleu (comme la pastille)
        doc.text(r.storage === 'stock3' ? 'stock 3e' : 'dessous', M + 40, y); doc.setTextColor(0); doc.setFont('helvetica', 'normal');
        if (r.lamp) { doc.setFont('helvetica', 'bold'); doc.text(r.lamp, M + 75, y, { maxWidth: 40 }); doc.setFont('helvetica', 'normal'); }
        const rem = [r.sav ? 'EN SAV' : '', r.lamp && r.current && r.current !== r.lamp ? `montée : ${r.current}` : '', r.gels.length ? `gel : ${r.gels.join(', ')}` : ''].filter(Boolean).join(' - ');
        if (rem) { doc.setFontSize(8); doc.text(rem, M + 118, y - 0.8, { maxWidth: W - M - (M + 118) }); }
        // 2e ligne : où il est monté en ce moment (spectacle précédent), position prévue, accessoires de la feuille de patch
        const l2 = [sec.key === 'monte' ? `en place : ${r.from}` : '', r.position ? `à monter : ${r.position}` : '', r.accessories.length ? `accessoires : ${labelsOf(ACCESSORIES, r.accessories).split(' · ').join(', ')}` : ''].filter(Boolean).join('  |  ');
        let h = 7;
        if (l2) { doc.setFontSize(8); doc.setTextColor(90); doc.text(l2, M + 40, y + 3.6, { maxWidth: W - 2 * M - 40 }); doc.setTextColor(0); h = 10; }
        doc.setDrawColor(200); doc.setLineWidth(0.1); doc.line(M, y - 4.8 + h, W - M, y - 4.8 + h);
        y += h;
      }
    }
  }
  // prêts et locations (pas d'ID : une ligne par prêt / location, en bleu)
  if (exts.length) {
    bar(`Prêts et locations`, exts.length, true);
    y += 3;   // un espace entre le liseré bleu et les cases à cocher
    for (const e of exts) {
      ensure(11); doc.setDrawColor(29, 107, 255); doc.setLineWidth(0.3); doc.rect(M + 6, y - 3.4, 4, 4);
      doc.setTextColor(29, 107, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(`${e.kind === 'pret' ? 'PRÊT' : 'LOCATION'}  ${e.text}`, M + 14, y, { maxWidth: W - 2 * M - 14 });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(e.dates + (e.accessories.length ? `  |  accessoires : ${e.accessories.join(', ')}` : ''), M + 14, y + 3.6, { maxWidth: W - 2 * M - 14 }); doc.setTextColor(0);
      doc.setDrawColor(200); doc.setLineWidth(0.1); doc.line(M, y + 5.2, W - M, y + 5.2); y += 10;
    }
  }
  // gélatines à couper puis accessoires à préparer (mêmes sections que dans le rapport de démontage)
  const ctx: PdfCtx = { doc, M, W, get y() { return y; }, set y(v: number) { y = v; }, ensure };
  drawGelSection(ctx, data, showId);
  drawHolderSection(ctx, data, showId);
  drawAccessorySection(ctx, data, showId);
  footer();
  const safe = show.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'spectacle';
  return { blob: doc.output('blob'), filename: `prepa-${safe}-${show.start_date}.pdf` };
}
