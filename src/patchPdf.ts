// PDF de la feuille de patch / focus : A4 paysage, lien de l'appli en en-tête, date et heure de génération sur chaque page
// (essentiel : le kit peut changer, on doit savoir de quand date la feuille), et dernière modification de la feuille.
import { GEL_COLORS } from './types';
import type { Data } from './types';
import { gelColorOf } from './gels';
import { ACCESSORIES, CURVES, labelsOf } from './patch';
import type { PatchRow } from './patch';
import { appReference } from './pdfHeader';

const DAY = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const HOUR = (d: Date) => `${String(d.getHours()).padStart(2, '0')}h${String(d.getMinutes()).padStart(2, '0')}`;
const ISO_DAY = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
const stamp = (d: Date) => `${DAY(d)} à ${HOUR(d)}`;

/** Colonnes du tableau (largeurs en mm, total = 277 = page A4 paysage moins 2 marges de 10). */
const COLS: { k: string; label: string; w: number }[] = [
  { k: 'circuit', label: 'CIRCUIT', w: 18 }, { k: 'dimmer', label: 'GRADA', w: 16 }, { k: 'curve', label: 'COURBE', w: 24 }, { k: 'dmx', label: 'DMX', w: 16 },
  { k: 'id', label: 'ID', w: 14 }, { k: 'model', label: 'MODÈLE', w: 44 }, { k: 'gels', label: 'GÉLATINES', w: 40 }, { k: 'accessories', label: 'ACCESSOIRES', w: 30 },
  { k: 'position', label: 'POSITION', w: 28 }, { k: 'focus', label: 'FOCUS', w: 12 }, { k: 'notes', label: 'NOTES', w: 35 }
];

/** Génère le PDF dans l'ordre des lignes reçues (celui de l'écran). jsPDF est chargé à la demande. */
export async function buildPatchPdf(data: Data, showId: string, rows: PatchRow[], now = new Date()): Promise<{ blob: Blob; filename: string }> {
  const show = data.shows.find((s) => s.id === showId);
  if (!show) throw new Error('Spectacle introuvable');
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const W = 297, H = 210, M = 10;
  const last = rows.filter((r) => r.updatedAt).sort((a, b) => b.updatedAt!.localeCompare(a.updatedAt!))[0];
  const generated = stamp(now);
  let y = M + 4;

  const head = () => {   // titre complet sur la première page, rappel court sur les suivantes
    doc.setTextColor(0); doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.text('Patch / Focus', M, y + 4);
    doc.setFontSize(12); doc.text(show.name, M + 42, y + 4);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); y += 10;
    doc.text(`Du ${ISO_DAY(show.start_date)} au ${ISO_DAY(show.end_date)}  -  ${rows.length} ligne${rows.length > 1 ? 's' : ''}  -  focus ${rows.filter((r) => r.focus).length}/${rows.length}`, M, y);
    y += 5;
    doc.setFont('helvetica', 'bold'); doc.setTextColor(200, 0, 0);
    doc.text(`Générée le ${generated}`, M, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(60);
    if (last) doc.text(`   -   dernière modification de la feuille le ${stamp(new Date(last.updatedAt!))}${last.updatedBy ? ' par ' + last.updatedBy : ''}`, M + doc.getTextWidth(`Générée le ${generated}`) + 1, y);
    doc.setTextColor(0); y += 5;
  };
  const tableHead = () => {
    doc.setFillColor(20, 20, 20); doc.rect(M, y - 4, W - 2 * M, 6.5, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(7);
    let x = M; for (const c of COLS) { doc.text(c.label, x + 1.5, y); x += c.w; }
    doc.setTextColor(0); y += 8;   // la première ligne démarre sous le bandeau
  };
  const gelRgb = (color: string): [number, number, number] => {
    const hex = GEL_COLORS.find(([n]) => n === color)?.[1] ?? '#8d6e63';
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  };
  const gelColor = (ref: string) => data.showGels.find((g) => g.show_id === showId && g.ref === ref)?.color ?? gelColorOf(ref);   // ligne sans projecteur : couleur déduite de la référence

  head(); tableHead();
  if (!rows.length) { doc.setFontSize(10); doc.text('Aucun projecteur affecté à ce spectacle.', M, y + 4); }
  for (const r of rows) {
    // texte de chaque cellule, découpé à la largeur de la colonne
    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    const cells: Record<string, string[]> = {
      circuit: [r.circuit], dimmer: [r.dimmer], curve: [labelsOf(CURVES, r.curve).replace('DIRECT', 'DIRECT')], dmx: [r.curve.includes('direct') ? r.dmx : ''],
      id: [r.itemId === null ? 'N/C' : String(r.itemId)], model: doc.splitTextToSize(r.model || '', COLS[5].w - 3) as string[], gels: [],
      accessories: doc.splitTextToSize(labelsOf(ACCESSORIES, r.accessories), COLS[7].w - 3) as string[], position: [r.position], focus: [''],
      notes: doc.splitTextToSize(r.notes || '', COLS[10].w - 3) as string[]
    };
    const gelRows = Math.max(1, Math.ceil(r.gels.length / 2));   // gélatines : deux par ligne (pastille de couleur + référence)
    const lines = Math.max(1, ...Object.values(cells).map((c) => c.length), gelRows);
    const h = lines * 4 + 3;
    if (y + h > H - 14) { doc.addPage(); y = M + 4; head(); tableHead(); }
    if (r.focus) { doc.setFillColor(226, 242, 230); doc.rect(M, y - 3.6, W - 2 * M, h, 'F'); }   // focus fait : fond vert pâle
    let x = M;
    for (const c of COLS) {
      const cx = x + 1.5;
      if (c.k === 'gels') {
        r.gels.forEach((g, i) => {
          const gx = x + 1.5 + (i % 2) * 19, gy = y + Math.floor(i / 2) * 4;
          doc.setFillColor(...gelRgb(gelColor(g))); doc.setDrawColor(0); doc.setLineWidth(0.2); doc.rect(gx, gy - 2.6, 2.8, 2.8, 'FD');
          doc.setFont('helvetica', 'normal'); doc.setTextColor(0); doc.text(g, gx + 3.6, gy, { maxWidth: 14.5 });
        });
      } else if (c.k === 'focus') {
        doc.setDrawColor(0); doc.setLineWidth(0.3); doc.rect(cx + 1, y - 3, 4, 4);
        if (r.focus) { doc.setLineWidth(0.5); doc.line(cx + 1.7, y - 1, cx + 2.8, y + 0.2); doc.line(cx + 2.8, y + 0.2, cx + 4.6, y - 2.4); }
      } else if (c.k === 'curve' && r.curve.includes('direct')) {
        doc.setFont('helvetica', 'bold'); doc.setTextColor(29, 107, 255);   // DIRECT en bleu, comme à l'écran
        const others = labelsOf(CURVES.filter((x) => x.k !== 'direct'), r.curve);
        doc.text(others ? ['DIRECT', others] : 'DIRECT', cx, y); doc.setTextColor(0); doc.setFont('helvetica', 'normal');
      } else {
        const bold = c.k === 'circuit' || c.k === 'dimmer' || c.k === 'id';
        doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 9 : 8); doc.setTextColor(r.itemId === null && c.k === 'id' ? 110 : 0);
        doc.text(cells[c.k], cx, y); doc.setTextColor(0); doc.setFontSize(8);
      }
      x += c.w;
    }
    doc.setDrawColor(190); doc.setLineWidth(0.1); doc.line(M, y - 3.6 + h, W - M, y - 3.6 + h);
    y += h;
  }
  // pied de page de chaque page : spectacle, date et heure de génération, numéro de page
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p); appReference(doc, W, M);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(`Patch / Focus - ${show.name} - générée le ${generated}`, M, H - 6); doc.text(`Page ${p} / ${n}`, W - M, H - 6, { align: 'right' });
  }
  const safe = show.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'spectacle';
  const d2 = (v: number) => String(v).padStart(2, '0');
  return { blob: doc.output('blob'), filename: `patch-${safe}-${now.getFullYear()}${d2(now.getMonth() + 1)}${d2(now.getDate())}-${d2(now.getHours())}${d2(now.getMinutes())}.pdf` };
}
