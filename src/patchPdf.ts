// PDF de la feuille de patch / focus (look « feuille de cahier griffonnée à la main ») : A4 paysage, lien de l'appli en en-tête, date et heure de génération sur chaque page
// (essentiel : le kit peut changer, on doit savoir de quand date la feuille), et dernière modification de la feuille.
import { GEL_COLORS } from './types';
import type { Data } from './types';
import { gelColorOf } from './gels';
import { ACCESSORIES, CURVES, labelsOf } from './patch';
import type { PatchRow } from './patch';
import { sortRows } from './patch';
import { positionGroups } from './patchLists';
import { appReference } from './pdfHeader';
import { HAND, addHandFont } from './pdfFonts';
import { noise, wobblePoints } from './handwriting';

const DAY = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const HOUR = (d: Date) => `${String(d.getHours()).padStart(2, '0')}h${String(d.getMinutes()).padStart(2, '0')}`;
const ISO_DAY = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
const stamp = (d: Date) => `${DAY(d)} à ${HOUR(d)}`;

/** Quel PDF : l'ordre de l'écran, un classement précis, ou tout dans un seul fichier (les gélatines à couper et accessoires sont dans la liste de prépa). */
export type PatchPdfKind = 'screen' | 'circuit' | 'dimmer' | 'position' | 'all';
export const PDF_KINDS: [PatchPdfKind, string][] = [
  ['screen', 'Feuille comme à l\'écran'], ['circuit', 'Circuit → Grada (classée par circuits)'], ['dimmer', 'Grada → Circuits (classée par grada)'],
  ['position', 'Par position (zones, puis positions)'], ['all', 'Toutes, dans un seul PDF']
];
type PCol = { k: string; label: string; w: number };

/** Colonnes du tableau (largeurs en mm, total = 277 = page A4 paysage moins 2 marges de 10). */
const COLS: PCol[] = [
  { k: 'circuit', label: 'CIRCUIT', w: 18 }, { k: 'dimmer', label: 'GRADA', w: 16 }, { k: 'curve', label: 'COURBE', w: 24 }, { k: 'dmx', label: 'DMX', w: 16 },
  { k: 'id', label: 'ID', w: 14 }, { k: 'model', label: 'MODÈLE', w: 44 }, { k: 'gels', label: 'GÉLATINES', w: 40 }, { k: 'accessories', label: 'ACCESSOIRES', w: 30 },
  { k: 'position', label: 'POSITION', w: 28 }, { k: 'focus', label: 'FOCUS', w: 12 }, { k: 'notes', label: 'NOTES', w: 35 }
];

/** Génère le PDF dans l'ordre des lignes reçues (celui de l'écran). jsPDF est chargé à la demande.
 *  Look cahier : papier crème, lignes bleues (une ligne du tableau = une ligne du cahier), marge rouge, écriture manuscrite bleue, traits tremblés. */
export async function buildPatchPdf(data: Data, showId: string, rows: PatchRow[], now = new Date(), kind: PatchPdfKind = 'screen'): Promise<{ blob: Blob; filename: string }> {
  const show = data.shows.find((s) => s.id === showId);
  if (!show) throw new Error('Spectacle introuvable');
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const hand = await addHandFont(doc);                         // police manuscrite ; sinon police normale
  const FONT = hand ? HAND : 'helvetica', K = hand ? 1.3 : 1;  // la manuscrite est plus petite à corps égal : on l'agrandit un peu
  const W = 297, H = 210, M = 10, R = 7;                       // R = écart des lignes du cahier (mm) = hauteur d'une ligne du tableau
  const TOP = 44;                                              // haut de la première ligne du tableau (sous les titres de colonnes)
  const INK: [number, number, number] = [28, 45, 125], PENCIL: [number, number, number] = [80, 80, 90], RED: [number, number, number] = [200, 40, 40];
  const last = rows.filter((r) => r.updatedAt).sort((a, b) => b.updatedAt!.localeCompare(a.updatedAt!))[0];
  const generated = stamp(now);
  let seed = 1;                                                // graine du tremblé : change à chaque trait, mais identique à chaque génération
  const font = (bold: boolean, size: number) => { doc.setFont(FONT, bold ? 'bold' : 'normal'); doc.setFontSize(size * K); };
  /** Police lisible (sans empattement) pour les informations de dernier niveau ; la manuscrite reste pour les titres et sous-titres. */
  const plain = (bold: boolean, size: number) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); };
  const say = (t: string | string[], x: number, y: number) => doc.text(t, x, y);   // texte posé droit, sans tremblé
  const color = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2]);
  /** Trait tremblé (suite de petits segments qui s'écartent un peu de la droite). */
  const pen = (x1: number, y1: number, x2: number, y2: number, amp = 0.22, step = 9) => {
    const p = wobblePoints(x1, y1, x2, y2, amp, step, (seed += 3));
    for (let i = 1; i < p.length; i++) doc.line(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
  };
  /** Petit carré tracé à la main (case à cocher, pastille de gélatine). */
  const box = (x: number, y: number, w: number, hh: number) => { pen(x, y, x + w, y, 0.12, 4); pen(x + w, y, x + w, y + hh, 0.12, 4); pen(x + w, y + hh, x, y + hh, 0.12, 4); pen(x, y + hh, x, y, 0.12, 4); };
  /** Écrit une chaîne (ou plusieurs lignes) avec un léger décalage et une petite inclinaison, comme à la main. */
  const write = (t: string | string[], x: number, y: number) => {
    seed += 5; const one = typeof t === 'string' || t.length === 1;
    doc.text(t, x + noise(seed) * 0.25, y + noise(seed + 1) * 0.35, one ? { angle: noise(seed + 2) * 0.9 } : undefined);
  };
  const paper = () => {   // fond de la page : papier crème, lignes bleues, double marge rouge
    doc.setFillColor(252, 249, 240); doc.rect(0, 0, W, H, 'F');
    doc.setDrawColor(172, 198, 232); doc.setLineWidth(0.2);
    for (let y = TOP; y < H - 8; y += R) pen(4, y, W - 4, y, 0.12, 14);
    doc.setDrawColor(214, 92, 92); doc.setLineWidth(0.3);
    const mx = M - 3; pen(mx, 0, mx, H, 0.1, 25); pen(mx + 1.3, 0, mx + 1.3, H, 0.1, 25);   // double marge rouge, à gauche du texte
  };
  let cur: { title: string; cols: PCol[] } = { title: '', cols: COLS };   // section en cours : titre (à droite de l'en-tête) et colonnes
  const header = () => {   // titre complet sur chaque page : on doit toujours savoir de quand date la feuille
    color(PENCIL); font(true, 22); write('Patch / Focus', M, 20);
    const tw = doc.getTextWidth('Patch / Focus ');
    color(INK); font(true, 16); write(show.name, M + tw + 6, 20);
    doc.setDrawColor(...RED); doc.setLineWidth(0.5); pen(M, 22.3, M + tw - 2, 22.3, 0.3, 6);   // soulignement rouge
    color(PENCIL); plain(false, 10); say(`Du ${ISO_DAY(show.start_date)} au ${ISO_DAY(show.end_date)}  -  ${rows.length} ligne${rows.length > 1 ? 's' : ''}  -  focus ${rows.filter((r) => r.focus).length}/${rows.length}`, M, 28);
    color(RED); plain(true, 10); say(`Générée le ${generated}`, M, 34);
    if (last) { const gw = doc.getTextWidth(`Générée le ${generated}`); color(PENCIL); plain(false, 10);
      say(`   -   dernière modification de la feuille le ${stamp(new Date(last.updatedAt!))}${last.updatedBy ? ' par ' + last.updatedBy : ''}`, M + gw + 1, 34); }
    if (cur.title) { color(INK); font(true, 15); write(cur.title, W - M - doc.getTextWidth(cur.title), 28); }   // nom de la feuille, en haut à droite
    font(true, 10); color(PENCIL);                                  // titres de colonnes, écrits à la main
    let x = M; for (const c of cur.cols) { write(c.label, x + 1.5, TOP - 2); x += c.w; }
    doc.setDrawColor(...PENCIL); doc.setLineWidth(0.45); pen(M, TOP, W - M, TOP, 0.2, 8);   // trait sous les titres
  };
  const gelRgb = (c: string): [number, number, number] => {
    const hex = GEL_COLORS.find(([n]) => n === c)?.[1] ?? '#8d6e63';
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  };
  const gelColor = (ref: string) => data.showGels.find((g) => g.show_id === showId && g.ref === ref)?.color ?? gelColorOf(ref);   // ligne sans projecteur : couleur déduite de la référence

  let y = TOP, started = false;                                 // haut de la ligne en cours ; une page a-t-elle déjà été créée ?
  const newPage = (first: boolean) => { if (!first) doc.addPage(); paper(); header(); };
  /** Commence une feuille sur une nouvelle page. */
  const begin = (title: string, cols: PCol[]) => { cur = { title, cols }; newPage(!started); started = true; y = TOP; };
  /** Titre d'une zone (« CINTRES »…) : une ligne de cahier, écrite en gras, soulignée en rouge. */
  const band = (label: string) => {
    if (y + 2 * R > H - 14) { newPage(false); y = TOP; }
    color(INK); font(true, 13); write(label.toUpperCase(), M + 1.5, y + 5);
    doc.setDrawColor(...RED); doc.setLineWidth(0.5); pen(M + 1, y + 6, M + 3 + doc.getTextWidth(label.toUpperCase()), y + 6, 0.25, 6);
    y += R;
  };
  /** Tableau de la feuille de patch, dans l'ordre reçu ; `groups` ajoute un titre de zone avant chaque paquet de lignes. */
  const patchTable = (title: string, cols: PCol[], groups: { label: string; sub?: string; rows: PatchRow[] }[]) => {
    begin(title, cols);
    let lastLabel = '\u0000';   // zone en cours : son titre n'est écrit qu'une fois
    const wOf = (k: string) => cols.find((c) => c.k === k)!.w;
    if (!groups.some((g) => g.rows.length)) { color(INK); plain(false, 11); say('Aucun projecteur affecté à ce spectacle.', M + 2, y + 5); }
    for (const g of groups) {
      if (g.label && g.label !== lastLabel) band(g.label);
      lastLabel = g.label;
      if (g.sub) {   // sous-titre : la position précise, en écriture manuscrite, soulignée au crayon
        if (y + 3 * R > H - 14) { newPage(false); y = TOP; }
        color(INK); font(true, 11.5); write(g.sub, M + 6, y + 5);
        doc.setDrawColor(...PENCIL); doc.setLineWidth(0.3); pen(M + 5, y + 6, M + 8 + doc.getTextWidth(g.sub), y + 6, 0.2, 5);
        y += R;
      }
      for (const r of g.rows) {
        // texte de chaque cellule, découpé à la largeur de la colonne (calculé avec la police et la taille réellement utilisées)
        plain(false, 9);
        const cells: Record<string, string[]> = {
          circuit: [r.circuit], dimmer: [r.dimmer], curve: [labelsOf(CURVES, r.curve)], dmx: [r.curve.includes('direct') ? r.dmx : ''],
          id: [r.itemId === null ? 'N/C' : String(r.itemId)], model: doc.splitTextToSize((r.model || '') + (r.extNote ? ` (${r.extNote})` : ''), wOf('model') - 3) as string[], gels: [],
          accessories: doc.splitTextToSize(labelsOf(ACCESSORIES, r.accessories), wOf('accessories') - 3) as string[], position: [r.position], focus: [''],
          notes: doc.splitTextToSize(r.notes || '', wOf('notes') - 3) as string[]
        };
        const gelRows = Math.max(1, Math.ceil(r.gels.length / 2));   // gélatines : deux par ligne (pastille de couleur + référence)
        const lines = Math.max(1, ...Object.values(cells).map((c) => c.length), gelRows);
        const h = Math.max(1, Math.ceil((lines * 4.2 + 2.8) / R)) * R;   // hauteur = un nombre entier de lignes du cahier
        if (y + h > H - 14) { newPage(false); y = TOP; }
        if (r.focus) {   // focus fait : coup de surligneur jaune-vert (transparent : les lignes du cahier restent visibles)
          doc.setGState(doc.GState({ opacity: 0.4 })); doc.setFillColor(200, 232, 120); doc.rect(M, y + 0.6, W - 2 * M, h - 1.2, 'F'); doc.setGState(doc.GState({ opacity: 1 }));
        }
        const base = y + 5;                                           // les écritures reposent sur la ligne du cahier
        let x = M;
        for (const c of cols) {
          const cx = x + 1.5;
          if (c.k === 'gels') {
            r.gels.forEach((g, i) => {
              const gx = x + 1.5 + (i % 2) * 19, gy = base + Math.floor(i / 2) * 4.2;
              doc.setFillColor(...gelRgb(gelColor(g))); doc.rect(gx, gy - 2.8, 3, 3, 'F');
              doc.setDrawColor(...PENCIL); doc.setLineWidth(0.25); box(gx, gy - 2.8, 3, 3);
              color(INK); plain(false, 9); say(g, gx + 4, gy);
            });
          } else if (c.k === 'focus') {
            doc.setDrawColor(...PENCIL); doc.setLineWidth(0.35); box(cx + 1, base - 3.6, 4.2, 4.2);
            if (r.focus) { doc.setDrawColor(20, 130, 60); doc.setLineWidth(0.7); pen(cx + 1.4, base - 1.2, cx + 2.8, base + 0.3, 0.1, 4); pen(cx + 2.8, base + 0.3, cx + 5.4, base - 4, 0.1, 4); }
          } else if (c.k === 'curve' && r.curve.includes('direct')) {
            plain(true, 9); doc.setTextColor(29, 107, 255);   // DIRECT en bleu vif, comme à l'écran
            const others = labelsOf(CURVES.filter((q) => q.k !== 'direct'), r.curve);
            say(others ? ['DIRECT', others] : 'DIRECT', cx, base); color(INK);
          } else {
            const bold = c.k === 'circuit' || c.k === 'dimmer' || c.k === 'id';
            plain(bold, bold ? 10.5 : 9); color(r.itemId === null && c.k === 'id' ? PENCIL : INK);
            say(cells[c.k], cx, base);
          }
          x += c.w;
        }
        y += h;
      }
    }
  };
  // colonnes du tableau : la clé de classement passe en premier (grada avant circuit pour « Grada → Circuits »)
  const swap = (first: string): PCol[] => [COLS.find((c) => c.k === first)!, ...COLS.filter((c) => c.k !== first)];
  const sheetCircuit = () => patchTable('Circuit -> Grada', swap('circuit'), [{ label: '', rows: sortRows(rows, 'circuit', 1) }]);
  const sheetDimmer = () => patchTable('Grada -> Circuits', swap('dimmer'), [{ label: '', rows: sortRows(rows, 'dimmer', 1) }]);
  const sheetPosition = () => patchTable('Par position', COLS, positionGroups(rows));
  if (kind === 'screen') patchTable('', COLS, [{ label: '', rows }]);
  if (kind === 'circuit' || kind === 'all') sheetCircuit();
  if (kind === 'dimmer' || kind === 'all') sheetDimmer();
  if (kind === 'position' || kind === 'all') sheetPosition();
  // pied de page de chaque page : spectacle, date et heure de génération, numéro de page
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p); appReference(doc, W, M);
    plain(false, 8); color(PENCIL);
    doc.text(`Patch / Focus - ${show.name} - générée le ${generated}`, M, H - 6); doc.text(`Page ${p} / ${n}`, W - M, H - 6, { align: 'right' });
  }
  const safe = show.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'spectacle';
  const d2 = (v: number) => String(v).padStart(2, '0');
  return { blob: doc.output('blob'), filename: `patch${kind === 'screen' ? '' : '-' + kind}-${safe}-${now.getFullYear()}${d2(now.getMonth() + 1)}${d2(now.getDate())}-${d2(now.getHours())}${d2(now.getMinutes())}.pdf` };
}
