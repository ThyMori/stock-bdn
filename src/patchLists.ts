// Listes tirées de la feuille de patch pour les PDF : lignes par zone et par position, accessoires par modèle (liste de prépa).
// Fonctions « pures » (sans DOM ni réseau) : testées dans tests/logic.test.ts.
import { ACCESSORIES, POSITIONS, POSITION_GROUPS, nat } from './patch';
import type { PatchRow } from './patch';

/** Lignes rangées par zone (Cintres, Cage de scène, FOH, Autres), puis par position précise (dans l'ordre de la liste), puis par numéro d'ID
 *  (les lignes sans projecteur « N/C » à la fin, par circuit). Les lignes sans position finissent dans « Sans position ». Une entrée = une position (`sub`). */
export function positionGroups(rows: PatchRow[]): { label: string; sub: string; rows: PatchRow[] }[] {
  const byId = (a: PatchRow, b: PatchRow) => (a.itemId ?? 1e9) - (b.itemId ?? 1e9) || nat(a.circuit, b.circuit);   // ID croissant, N/C à la fin
  const out: { label: string; sub: string; rows: PatchRow[] }[] = [];
  for (const g of POSITION_GROUPS) for (const pos of g.items) {
    const list = rows.filter((r) => r.position === pos).sort(byId);
    if (list.length) out.push({ label: g.label, sub: pos, rows: list });   // positions vides non affichées
  }
  const none = rows.filter((r) => !POSITIONS.includes(r.position)).sort(byId);   // position vide ou inconnue
  if (none.length) out.push({ label: 'Sans position', sub: '', rows: none });
  return out;
}

/** Circuits renseignés, triés, séparés par des virgules (« - » si aucun). */
const circuitsText = (cs: string[]): string => cs.filter(Boolean).sort(nat).join(', ') || '-';

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
