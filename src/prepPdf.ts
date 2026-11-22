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

/** Gélatines du spectacle : une section par « format de projecteur » (PAR64, 613 SX / 614 SX…).
 *  Les modèles qui ont la même taille de porte-filtre sont regroupés dans une même section ; sans taille connue, un modèle = une section.
 *  Dans chaque section : couleur la plus proche, puis référence. */
export function gelGroups(data: Data, showId: string): GelGroup[] {
  const rows = data.showGels.filter((x) => x.show_id === showId).map((g) => {
    const it = data.items.find((i) => i.id === g.item_id);
    const d = it ? describe(data, it) : null;
    const model = d?.model?.name ?? '?';
    const size = d?.filter?.label ?? '';
    return { g, model, size, key: size || 'm:' + model };
  });
  // lignes de la feuille de patch sans projecteur (location, prêt, à louer) : leurs gélatines comptent aussi (modèle indiqué, pas de numéro)
  for (const l of data.patchLines.filter((x) => x.show_id === showId && x.item_id === null)) {
    const model = data.models.find((m) => m.id === l.model_id)?.name ?? (l.model_text || 'Sans modèle');
    for (const g of l.gels ?? []) rows.push({ g: { show_id: showId, item_id: 0, ref: g.ref, color: g.color } as (typeof rows)[number]['g'], model, size: '', key: 'm:' + model });
  }
  const models = new Map<string, Set<string>>();
  for (const r of rows) { const m = models.get(r.key) ?? new Set<string>(); m.add(r.model); models.set(r.key, m); }
  const titleOf = (k: string) => [...(models.get(k) ?? [])].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true })).join(' / ');
  const map = new Map<string, GelGroup>();
  for (const r of rows) {
    const key = [r.key, r.g.color, r.g.ref.trim().toLowerCase()].join('|');
    const cur = map.get(key) ?? { title: titleOf(r.key), size: r.size, color: r.g.color, ref: r.g.ref.trim(), qty: 0, items: [] };
    cur.qty++; if (r.g.item_id) cur.items.push(r.g.item_id); map.set(key, cur);
  }
  const rank = (c: string) => { const i = GEL_COLORS.findIndex(([n]) => n === c); return i < 0 ? 99 : i; };
  return [...map.values()].map((g) => ({ ...g, items: [...g.items].sort((a, b) => a - b) }))
    .sort((a, b) => a.title.localeCompare(b.title, 'fr', { numeric: true }) || rank(a.color) - rank(b.color) || a.ref.localeCompare(b.ref, 'fr', { numeric: true }));
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
    const txt = 'ATTENTION - matériel manquant : ' + miss.map((x) => `${x.missing} x ${data.models.find((m) => m.id === x.model_id)?.name ?? '?'}${x.lamp_id ? ' ' + (data.lamps.find((l) => l.id === x.lamp_id)?.name ?? '') : ''}`).join(', ');
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
  // gélatines : par format (sous-titre), puis couleur
  const gels = gelGroups(data, showId);
  if (gels.length) {
    ensure(30); y += 8;
    doc.setFillColor(20, 20, 20); doc.rect(M, y - 4.5, W - 2 * M, 7, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(`Gélatines à couper  (${gels.reduce((n, g) => n + g.qty, 0)})`, M + 2, y); doc.setTextColor(0);
    y += 7; let lastTitle = '';
    for (const g of gels) {
      if (g.title !== lastTitle) {
        ensure(18); if (lastTitle) y += 3; doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(0); doc.text(g.title, M + 2, y); if (g.size) { doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110); doc.text(`(${g.size})`, W - M - 2, y, { align: 'right' }); doc.setTextColor(0); }
        doc.setDrawColor(0); doc.setLineWidth(0.2); doc.line(M, y + 1.8, W - M, y + 1.8); y += 7; lastTitle = g.title;
      }
      ensure(9);
      const hex = GEL_COLORS.find(([n]) => n === g.color)?.[1] ?? '#8d6e63';
      doc.setDrawColor(0); doc.setLineWidth(0.3); doc.rect(M + 6, y - 3.4, 4, 4);
      doc.setFillColor(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)); doc.setLineWidth(0.2); doc.rect(M + 13, y - 3.4, 4, 4, 'FD');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(g.ref, M + 24, y, { maxWidth: 62 });
      doc.text(`x ${g.qty}`, M + 90, y);
      doc.setDrawColor(200); doc.setLineWidth(0.1); doc.line(M, y + 2.2, W - M, y + 2.2);
      y += 7;
    }
  }
  // accessoires à préparer : par modèle, avec les numéros des projecteurs concernés (feuille de patch, lignes sans projecteur comprises)
  const acc = accessoryList(buildRows(data, showId, data.patchLines));
  if (acc.length) {
    ensure(30); y += 8;
    doc.setFillColor(20, 20, 20); doc.rect(M, y - 4.5, W - 2 * M, 7, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(`Accessoires à préparer  (${acc.reduce((n, a) => n + a.qty, 0)})`, M + 2, y); doc.setTextColor(0);
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
  footer();
  const safe = show.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'spectacle';
  return { blob: doc.output('blob'), filename: `prepa-${safe}-${show.start_date}.pdf` };
}
