// Listes tirées de la feuille de patch pour le PDF : lignes par zone, gélatines à couper, accessoires par modèle.
// Fonctions « pures » (sans DOM ni réseau) : testées dans tests/logic.test.ts.
import { ACCESSORIES, POSITIONS, POSITION_GROUPS, nat, sortRows } from './patch';
import type { PatchRow } from './patch';

/** Lignes rangées par zone (Cintres, Cage de scène, FOH, Autres), dans l'ordre de la liste des positions, puis par circuit. Les lignes sans position finissent dans « Sans position ». */
export function positionGroups(rows: PatchRow[]): { label: string; rows: PatchRow[] }[] {
  const byCircuit = sortRows(rows, 'circuit', 1);                                   // base : classées par circuit
  const out = POSITION_GROUPS.map((g) => ({ label: g.label, rows: [] as PatchRow[] }));
  const none: PatchRow[] = [];
  for (const r of byCircuit) {
    const gi = POSITION_GROUPS.findIndex((g) => g.items.includes(r.position));       // zone de la position (−1 si vide ou inconnue)
    if (gi < 0) none.push(r); else out[gi].rows.push(r);
  }
  for (const g of out) g.rows.sort((a, b) => POSITIONS.indexOf(a.position) - POSITIONS.indexOf(b.position));   // tri stable : l'ordre par circuit est gardé à position égale
  return [...out, { label: 'Sans position', rows: none }].filter((g) => g.rows.length);   // zones vides non affichées
}

/** Texte « PAR64 ×3, Découpe ×2 » : combien de projecteurs de chaque modèle. */
const countText = (m: Map<string, number>): string => [...m.entries()].sort((a, b) => nat(a[0], b[0])).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ');
/** Circuits renseignés, triés, séparés par des virgules (« - » si aucun). */
const circuitsText = (cs: string[]): string => cs.filter(Boolean).sort(nat).join(', ') || '-';

export interface GelItem { ref: string; qty: number; models: string; circuits: string }
/** Gélatines à couper : une ligne par référence (classées par référence), avec la quantité, les modèles concernés et les circuits. */
export function gelList(rows: PatchRow[]): GelItem[] {
  const m = new Map<string, { qty: number; models: Map<string, number>; circuits: string[] }>();
  for (const r of rows) for (const ref of r.gels) {
    const e = m.get(ref) ?? { qty: 0, models: new Map<string, number>(), circuits: [] };
    e.qty++; const mod = r.model || 'Sans modèle'; e.models.set(mod, (e.models.get(mod) ?? 0) + 1); e.circuits.push(r.circuit);
    m.set(ref, e);
  }
  return [...m.entries()].sort((a, b) => nat(a[0], b[0])).map(([ref, e]) => ({ ref, qty: e.qty, models: countText(e.models), circuits: circuitsText(e.circuits) }));
}

export interface AccItem { model: string; accessory: string; qty: number; circuits: string; ids: string }
/** Numéros des projecteurs triés, puis « N/C » pour les lignes sans projecteur (« 12, 15, 2 N/C »). */
const idsText = (ids: (number | null)[]): string => { const n = ids.filter((x): x is number => x !== null).sort((a, b) => a - b).map(String); const nc = ids.length - n.length; return [...n, ...(nc ? [`${nc} N/C`] : [])].join(', ') || '-'; };
/** Accessoires : une ligne par couple (modèle, accessoire), classées par modèle puis dans l'ordre des accessoires. */
export function accessoryList(rows: PatchRow[]): AccItem[] {
  const m = new Map<string, { model: string; k: string; qty: number; circuits: string[]; ids: (number | null)[] }>();
  for (const r of rows) for (const k of r.accessories) {
    const model = r.model || 'Sans modèle', id = model + '\u0000' + k;
    const e = m.get(id) ?? { model, k, qty: 0, circuits: [], ids: [] };
    e.qty++; e.circuits.push(r.circuit); e.ids.push(r.itemId); m.set(id, e);
  }
  const order = (k: string) => ACCESSORIES.findIndex((a) => a.k === k);
  return [...m.values()].sort((a, b) => nat(a.model, b.model) || order(a.k) - order(b.k))
    .map((e) => ({ model: e.model, accessory: ACCESSORIES.find((a) => a.k === e.k)?.label ?? e.k, qty: e.qty, circuits: circuitsText(e.circuits), ids: idsText(e.ids) }));
}
