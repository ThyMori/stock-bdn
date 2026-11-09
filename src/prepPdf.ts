import { GEL_COLORS } from './types';
import type { Data } from './types';
import { describe } from './ref';
import { externalLabel } from './alerts';

const DAY = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);

export interface PrepRow { id: number; model: string; type: string; lamp: string; current: string; sav: boolean; gels: string[] }
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
  const models = new Map<string, Set<string>>();
  for (const r of rows) { const m = models.get(r.key) ?? new Set<string>(); m.add(r.model); models.set(r.key, m); }
  const titleOf = (k: string) => [...(models.get(k) ?? [])].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true })).join(' / ');
  const map = new Map<string, GelGroup>();
  for (const r of rows) {
    const key = [r.key, r.g.color, r.g.ref.trim().toLowerCase()].join('|');
    const cur = map.get(key) ?? { title: titleOf(r.key), size: r.size, color: r.g.color, ref: r.g.ref.trim(), qty: 0, items: [] };
    cur.qty++; cur.items.push(r.g.item_id); map.set(key, cur);
  }
  const rank = (c: string) => { const i = GEL_COLORS.findIndex(([n]) => n === c); return i < 0 ? 99 : i; };
  return [...map.values()].map((g) => ({ ...g, items: [...g.items].sort((a, b) => a - b) }))
    .sort((a, b) => a.title.localeCompare(b.title, 'fr', { numeric: true }) || rank(a.color) - rank(b.color) || a.ref.localeCompare(b.ref, 'fr', { numeric: true }));
}

/** Lignes de la liste de prépa : projecteurs du spectacle, triés par type, modèle puis numéro. */
export function prepRows(data: Data, showId: string): PrepRow[] {
  const name = (id: string | null | undefined) => data.lamps.find((l) => l.id === id)?.name ?? '';
  return data.showItems.filter((s) => s.show_id === showId).map((s) => {
    const it = data.items.find((i) => i.id === s.item_id);
    const d = it ? describe(data, it) : null;
    const isPar = /^PAR/i.test(d?.type?.name ?? '');
    return { id: s.item_id, model: d?.model?.name ?? '?', type: d?.type?.name ?? 'Sans type',
      lamp: isPar ? name(s.lamp_id) || 'à préciser' : '', current: isPar && it ? name(it.lamp_id) : '', sav: !!it && it.status === 'sav',
      gels: data.showGels.filter((g) => g.show_id === showId && g.item_id === s.item_id).map((g) => g.ref).sort() };
  }).sort((a, b) => a.type.localeCompare(b.type, 'fr') || a.model.localeCompare(b.model, 'fr', { numeric: true }) || a.id - b.id);
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
    for (let p = 1; p <= n; p++) { doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
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
  const exts = data.showExternals.filter((e) => e.show_id === showId);
  if (exts.length) {
    y += 3; doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(29, 107, 255); doc.text('Matériel prêté / loué', M, y); y += 5; doc.setFont('helvetica', 'normal');
    for (const e of exts) { const t = `${externalLabel(data, e)} - livraison ${DAY(e.delivery_date)}, reprise ${DAY(e.return_date)}`; ensure(6); doc.text(t, M + 2, y, { maxWidth: W - 2 * M - 2 }); y += 5 * Math.ceil(doc.getTextWidth(t) / (W - 2 * M - 2)); }
    doc.setTextColor(0);
  }
  // récapitulatif par type
  const types = [...new Set(rows.map((r) => r.type))];
  if (types.length) {
    y += 3; doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text('Récapitulatif', M, y); doc.setFont('helvetica', 'normal'); y += 5;
    doc.text(types.map((t) => `${t} : ${rows.filter((r) => r.type === t).length}`).join('   '), M, y, { maxWidth: W - 2 * M });
    y += 5 * Math.ceil(doc.getTextWidth(types.map((t) => `${t} : ${rows.filter((r) => r.type === t).length}`).join('   ')) / (W - 2 * M)) + 2;
  }
  if (!rows.length) { y += 8; doc.text('Aucun projecteur assigné à ce spectacle.', M, y); }

  for (const t of types) {
    const list = rows.filter((r) => r.type === t);
    ensure(24);
    y += 5;
    doc.setFillColor(20, 20, 20); doc.rect(M, y - 4.5, W - 2 * M, 7, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(`${t}  (${list.length})`, M + 2, y); doc.setTextColor(0);
    y += 6; doc.setFontSize(8); doc.setTextColor(110);
    doc.text('PRÉPARÉ', M + 2, y); doc.text('N°', M + 24, y); doc.text('MODÈLE', M + 40, y); doc.text('LAMPE REQUISE', M + 105, y); doc.text('REMARQUE', M + 140, y);
    doc.setTextColor(0); doc.setLineWidth(0.2); doc.line(M, y + 1.5, W - M, y + 1.5); y += 6;
    for (const r of list) {
      ensure(8);
      doc.setDrawColor(0); doc.setLineWidth(0.3); doc.rect(M + 6, y - 3.4, 4, 4);       // case à cocher
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(String(r.id), M + 24, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(r.model, M + 40, y, { maxWidth: 62 });
      if (r.lamp) { doc.setFont('helvetica', 'bold'); doc.text(r.lamp, M + 105, y); doc.setFont('helvetica', 'normal'); }
      const rem = [r.sav ? 'EN SAV' : '', r.lamp && r.current && r.current !== r.lamp ? `montée : ${r.current}` : '', r.gels.length ? `gel : ${r.gels.join(', ')}` : ''].filter(Boolean).join(' - ');
      if (rem) { doc.setFontSize(8); doc.text(rem, M + 140, y - 0.8, { maxWidth: W - M - (M + 140) }); }
      doc.setDrawColor(200); doc.setLineWidth(0.1); doc.line(M, y + 2.2, W - M, y + 2.2);
      y += 7;
    }
  }
  // gélatines : par format (sous-titre), puis couleur
  const gels = gelGroups(data, showId);
  if (gels.length) {
    ensure(30); y += 8;
    doc.setFillColor(20, 20, 20); doc.rect(M, y - 4.5, W - 2 * M, 7, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(`Gélatines  (${gels.reduce((n, g) => n + g.qty, 0)})`, M + 2, y); doc.setTextColor(0);
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
  footer();
  const safe = show.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'spectacle';
  return { blob: doc.output('blob'), filename: `prepa-${safe}-${show.start_date}.pdf` };
}
