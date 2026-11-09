import type { Data } from './types';
import { describe } from './ref';

const DAY = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);

export interface TdRow { id: number; model: string; type: string; sav: boolean; isPar: boolean;
  /** PAR : lampe du spectacle en cours / lampe requise par le suivant (« » si non précisée) */
  from: string; to: string; change: boolean; toUnknown: boolean }
export interface Teardown { prepare: TdRow[]; keep: TdRow[]; store: TdRow[] }

/** Compare le matériel du spectacle en cours et du prochain : à préparer / à conserver / à ranger (gélatines ignorées). */
export function compareShows(data: Data, curId: string, nextId: string): Teardown {
  const name = (id: string | null | undefined) => data.lamps.find((l) => l.id === id)?.name ?? '';
  const cur = new Map(data.showItems.filter((s) => s.show_id === curId).map((s) => [s.item_id, s]));
  const nxt = new Map(data.showItems.filter((s) => s.show_id === nextId).map((s) => [s.item_id, s]));
  const row = (id: number): TdRow => {
    const it = data.items.find((i) => i.id === id);
    const d = it ? describe(data, it) : null;
    const isPar = /^PAR/i.test(d?.type?.name ?? '');
    const from = isPar ? name(cur.get(id)?.lamp_id) || name(it?.lamp_id) : '';
    const to = isPar ? name(nxt.get(id)?.lamp_id) : '';
    return { id, model: d?.model?.name ?? '?', type: d?.type?.name ?? 'Sans type', sav: !!it && it.status === 'sav', isPar,
      from, to, change: isPar && !!from && !!to && from !== to, toUnknown: isPar && nxt.has(id) && !to };
  };
  const sort = (a: TdRow, b: TdRow) => a.type.localeCompare(b.type, 'fr') || a.model.localeCompare(b.model, 'fr', { numeric: true }) || a.id - b.id;
  return {
    prepare: [...nxt.keys()].filter((i) => !cur.has(i)).map(row).sort(sort),
    keep: [...nxt.keys()].filter((i) => cur.has(i)).map(row).sort(sort),
    store: [...cur.keys()].filter((i) => !nxt.has(i)).map(row).sort(sort)
  };
}

export async function buildTeardownPdf(data: Data, curId: string, nextId: string, now = new Date()): Promise<{ blob: Blob; filename: string }> {
  const show = data.shows.find((s) => s.id === curId), next = data.shows.find((s) => s.id === nextId);
  if (!show || !next) throw new Error('Spectacle introuvable');
  const td = compareShows(data, curId, nextId);
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 15, H = 297;
  let y = M;
  const footer = () => {
    const n = doc.getNumberOfPages();
    for (let p = 1; p <= n; p++) { doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
      doc.text(`Rapport de démontage - ${show.name} > ${next.name}`, M, H - 8, { maxWidth: W - 2 * M - 25 }); doc.text(`Page ${p} / ${n}`, W - M, H - 8, { align: 'right' }); }
  };
  const ensure = (h: number) => { if (y + h > H - 16) { doc.addPage(); y = M; } };
  const changes = td.keep.filter((r) => r.change || r.toUnknown);

  doc.setTextColor(0); doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('Rapport de démontage', M, y + 6);
  doc.setFontSize(14); y += 14; doc.text(show.name, M, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); y += 6;
  doc.text(`Du ${DAY(show.start_date)} au ${DAY(show.end_date)}`, M, y); y += 5;
  doc.text(`Prochain spectacle : ${next.name} (du ${DAY(next.start_date)} au ${DAY(next.end_date)})`, M, y, { maxWidth: W - 2 * M }); y += 5;
  doc.setTextColor(110); doc.text(`Générée le ${DAY(now.toISOString())}`, M, y); doc.setTextColor(0); y += 8;
  doc.setFont('helvetica', 'bold'); doc.text('Récapitulatif', M, y); doc.setFont('helvetica', 'normal'); y += 5;
  doc.text(`À préparer : ${td.prepare.length}     À conserver : ${td.keep.length}     À ranger : ${td.store.length}`, M, y); y += 5;
  if (changes.length) { doc.setTextColor(200, 0, 0); doc.setFont('helvetica', 'bold'); doc.text(`Attention : ${changes.length} PAR à vérifier / changer de lampe`, M, y); doc.setTextColor(0); doc.setFont('helvetica', 'normal'); y += 5; }

  const section = (title: string, sub: string, rows: TdRow[], lampCol: string) => {
    ensure(30); y += 8;
    doc.setFillColor(20, 20, 20); doc.rect(M, y - 4.5, W - 2 * M, 7, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(`${title}  (${rows.length})`, M + 2, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(sub, W - M - 2, y, { align: 'right' }); doc.setTextColor(0);
    y += 7;
    if (!rows.length) { doc.setFontSize(10); doc.setTextColor(110); doc.text('Aucun projecteur.', M + 2, y); doc.setTextColor(0); y += 4; return; }
    let lastType = '';
    for (const r of rows) {
      if (r.type !== lastType) {
        ensure(16); doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(90); doc.text(r.type.toUpperCase(), M + 2, y);
        if (lampCol && r.isPar) doc.text(lampCol, M + 105, y);
        doc.setTextColor(0); doc.setLineWidth(0.2); doc.setDrawColor(0); doc.line(M, y + 1.5, W - M, y + 1.5); y += 6; lastType = r.type;
      }
      ensure(8);
      doc.setDrawColor(0); doc.setLineWidth(0.3); doc.rect(M + 6, y - 3.4, 4, 4);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(String(r.id), M + 24, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(r.model + (r.sav ? '  (EN SAV)' : ''), M + 40, y, { maxWidth: 62 });
      if (r.isPar && lampCol) {
        if (title === 'À conserver') {
          if (r.change) { doc.setFont('helvetica', 'bold'); doc.setTextColor(200, 0, 0); doc.text(`CHANGER : ${r.from} > ${r.to}`, M + 105, y); doc.setTextColor(0); }
          else if (r.toUnknown) { doc.setFont('helvetica', 'bold'); doc.setTextColor(200, 0, 0); doc.text(`lampe à préciser (actuelle ${r.from || '?'})`, M + 105, y, { maxWidth: W - M - M - 105 }); doc.setTextColor(0); }
          else { doc.setTextColor(110); doc.text(`${r.to || r.from || '-'} (inchangée)`, M + 105, y); doc.setTextColor(0); }
        } else { doc.setFont('helvetica', 'bold'); doc.text(r.to || 'à préciser', M + 105, y); }
      }
      doc.setDrawColor(200); doc.setLineWidth(0.1); doc.line(M, y + 2.2, W - M, y + 2.2);
      y += 7;
    }
  };
  section('À préparer', 'prévus pour la suite, absents du spectacle en cours', td.prepare, 'LAMPE REQUISE');
  section('À conserver', 'dans les deux spectacles', td.keep, 'LAMPE');
  section('À ranger', 'présents sur ce spectacle, absents du suivant', td.store, '');
  footer();
  const safe = show.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'spectacle';
  return { blob: doc.output('blob'), filename: `demontage-${safe}-${show.end_date}.pdf` };
}
