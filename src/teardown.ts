import type { Data } from './types';
import { describe } from './ref';
import { appReference } from './pdfHeader';
import { externalLabel } from './alerts';
import { patchPosition, positionBefore, posLabel } from './position';

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

/** Une ligne du plan de démontage / remontage : un projecteur et ce qu'on doit en faire. */
export interface PlanRow extends TdRow { oldPos: string; newPos: string; origin: string }
/** Plan complet : ce qui part au stock (dessous / 3e), ce qui reste en place, ce qui bouge, ce qui est à monter. */
export interface Plan { dessous: PlanRow[]; stock3: PlanRow[]; keep: PlanRow[]; move: PlanRow[]; mount: PlanRow[] }

/** Plan de démontage du spectacle en cours (positions de sa feuille de patch) vers le prochain (positions de la sienne).
 *  - dans l'ancien, pas dans le nouveau : à stocker (3e si pastille bleue, sinon dessous) ;
 *  - dans les deux, même position : à garder en place (cintres, allemandes, passerelles, sols…) ;
 *  - dans les deux, position différente : à déplacer ;
 *  - dans le nouveau seulement : à monter (avec sa provenance : stock dessous, stock 3e, prêt, SAV, ou spectacle d'avant). */
export function teardownPlan(data: Data, curId: string, nextId: string): Plan {
  const td = compareShows(data, curId, nextId), next = data.shows.find((s) => s.id === nextId);
  const lab = (p: string) => p || 'position non renseignée';
  const ext = (r: TdRow): PlanRow => ({ ...r, oldPos: patchPosition(data, curId, r.id), newPos: patchPosition(data, nextId, r.id), origin: '' });
  const blue = (id: number) => !!data.items.find((i) => i.id === id)?.blue_dot;
  const sortPos = (a: PlanRow, b: PlanRow) => lab(a.newPos).localeCompare(lab(b.newPos), 'fr', { numeric: true }) || a.type.localeCompare(b.type, 'fr') || a.model.localeCompare(b.model, 'fr', { numeric: true }) || a.id - b.id;
  const stored = td.store.map(ext);
  const both = td.keep.map(ext);
  return {
    dessous: stored.filter((r) => !blue(r.id)),
    stock3: stored.filter((r) => blue(r.id)),
    keep: both.filter((r) => r.oldPos === r.newPos),
    move: both.filter((r) => r.oldPos !== r.newPos).sort(sortPos),
    mount: td.prepare.map(ext).map((r) => ({ ...r, origin: next ? posLabel(positionBefore(data, r.id, next)) : '' })).sort(sortPos)
  };
}

export async function buildTeardownPdf(data: Data, curId: string, nextId: string, now = new Date()): Promise<{ blob: Blob; filename: string }> {
  const show = data.shows.find((s) => s.id === curId), next = data.shows.find((s) => s.id === nextId);
  if (!show || !next) throw new Error('Spectacle introuvable');
  const plan = teardownPlan(data, curId, nextId);
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 15, H = 297;
  let y = M;
  const footer = () => {
    const n = doc.getNumberOfPages();
    for (let p = 1; p <= n; p++) { doc.setPage(p); appReference(doc, W, M); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
      doc.text(`Rapport de démontage - ${show.name} > ${next.name}`, M, H - 8, { maxWidth: W - 2 * M - 25 }); doc.text(`Page ${p} / ${n}`, W - M, H - 8, { align: 'right' }); }
  };
  const ensure = (h: number) => { if (y + h > H - 16) { doc.addPage(); y = M; } };
  const changes = [...plan.keep, ...plan.move].filter((r) => r.change || r.toUnknown);

  doc.setTextColor(0); doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('Rapport de démontage', M, y + 6);
  doc.setFontSize(14); y += 14; doc.text(show.name, M, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); y += 6;
  doc.text(`Du ${DAY(show.start_date)} au ${DAY(show.end_date)}`, M, y); y += 5;
  doc.text(`Prochain spectacle : ${next.name} (du ${DAY(next.start_date)} au ${DAY(next.end_date)})`, M, y, { maxWidth: W - 2 * M }); y += 5;
  doc.setTextColor(110); doc.text(`Générée le ${DAY(now.toISOString())}`, M, y); doc.setTextColor(0); y += 8;
  doc.setFont('helvetica', 'bold'); doc.text('Récapitulatif', M, y); doc.setFont('helvetica', 'normal'); y += 5;
  const recap = `Stock dessous : ${plan.dessous.length}   Stock 3e : ${plan.stock3.length}   En place : ${plan.keep.length}   À déplacer : ${plan.move.length}   À monter : ${plan.mount.length}`;
  doc.text(recap, M, y, { maxWidth: W - 2 * M }); y += 5 * Math.ceil(doc.getTextWidth(recap) / (W - 2 * M));
  if (changes.length) { doc.setTextColor(200, 0, 0); doc.setFont('helvetica', 'bold'); doc.text(`Attention : ${changes.length} PAR à vérifier / changer de lampe`, M, y); doc.setTextColor(0); doc.setFont('helvetica', 'normal'); y += 5; }

  const section = (title: string, sub: string, rows: PlanRow[], lampCol: string, info: (r: PlanRow) => string, blue = false) => {
    ensure(30); y += 8;
    if (blue) doc.setFillColor(29, 107, 255); else doc.setFillColor(20, 20, 20); doc.rect(M, y - 4.5, W - 2 * M, 7, 'F');
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
        if (title === 'À garder en place' || title === 'À déplacer') {
          if (r.change) { doc.setFont('helvetica', 'bold'); doc.setTextColor(200, 0, 0); doc.text(`CHANGER : ${r.from} > ${r.to}`, M + 105, y); doc.setTextColor(0); }
          else if (r.toUnknown) { doc.setFont('helvetica', 'bold'); doc.setTextColor(200, 0, 0); doc.text(`lampe à préciser (actuelle ${r.from || '?'})`, M + 105, y, { maxWidth: W - M - M - 105 }); doc.setTextColor(0); }
          else { doc.setTextColor(110); doc.text(`${r.to || r.from || '-'} (inchangée)`, M + 105, y); doc.setTextColor(0); }
        } else { doc.setFont('helvetica', 'bold'); doc.text(r.to || 'à préciser', M + 105, y); }
      }
      const inf = info(r), two = !!inf && r.isPar && !!lampCol;     // PAR : la lampe prend la 1re ligne, l'info passe dessous
      if (inf) { doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(90); doc.text(inf, M + 105, two ? y + 3.6 : y, { maxWidth: W - M - (M + 105) }); doc.setTextColor(0); }
      const h = two ? 10 : 7;
      doc.setDrawColor(200); doc.setLineWidth(0.1); doc.line(M, y - 4.8 + h, W - M, y - 4.8 + h + 0);
      y += h;
    }
  };
  const from = (r: PlanRow) => (r.oldPos ? `était : ${r.oldPos}` : '');
  section('À stocker dessous', 'projecteurs sans pastille, absents du spectacle suivant', plan.dessous, '', from);
  section('À stocker au 3e', 'projecteurs à pastille bleue, absents du spectacle suivant', plan.stock3, '', from, true);
  section('À garder en place', 'même position dans les deux spectacles (cintres, allemandes, passerelles, sols…)', plan.keep, 'LAMPE', (r) => r.newPos);
  section('À déplacer', 'dans les deux spectacles, à une autre position', plan.move, 'LAMPE', (r) => `${r.oldPos || '?'} > ${r.newPos || '?'}`);
  section('À monter', 'nouveaux pour le spectacle suivant, avec leur provenance', plan.mount, 'LAMPE REQUISE', (r) => `${r.newPos || 'position ?'}  (de : ${r.origin})`);
  const exts = data.showExternals.filter((e) => e.show_id === curId).sort((a, b) => a.return_date.localeCompare(b.return_date));
  if (exts.length) {
    ensure(30); y += 8;
    doc.setFillColor(29, 107, 255); doc.rect(M, y - 4.5, W - 2 * M, 7, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(`À rendre (${exts.reduce((n, e) => n + e.qty, 0)})`, M + 2, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text('prêts et locations de ce spectacle', W - M - 2, y, { align: 'right' }); doc.setTextColor(0); y += 8;
    for (const e of exts) {
      ensure(9); doc.setDrawColor(0); doc.setLineWidth(0.3); doc.rect(M + 6, y - 3.4, 4, 4);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(externalLabel(data, e), M + 14, y, { maxWidth: 110 });
      doc.setFont('helvetica', 'normal'); doc.text(`reprise le ${DAY(e.return_date)}`, W - M - 2, y, { align: 'right' });
      doc.setDrawColor(200); doc.setLineWidth(0.1); doc.line(M, y + 2.2, W - M, y + 2.2); y += 7;
    }
  }
  footer();
  const safe = show.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'spectacle';
  return { blob: doc.output('blob'), filename: `demontage-${safe}-${show.end_date}.pdf` };
}
