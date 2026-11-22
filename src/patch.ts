// Feuille de patch / focus : logique pure (aucun accès réseau ni DOM), testée dans tests/logic.test.ts.
import type { Data } from './types';
import { describe } from './ref';

/** Ligne enregistrée en base (table patch_lines). `item_id` nul = ligne « N/C » (sans projecteur). */
export interface PatchLine {
  id: string; show_id: string; item_id: number | null; circuit: string; dimmer: string; curve: string[]; dmx: string;
  model_text: string; accessories: string[]; position: string; focus: boolean; notes: string; updated_at: string; updated_by_label: string | null;
  external_id?: string | null;   // ligne N/C rattachée à une location / un prêt du spectacle
  model_id?: string | null; lamp_id?: string | null;   // ligne N/C préparée : modèle du catalogue (et lampe voulue pour un PAR)
  gels?: { ref: string; color: string }[];   // gélatines d'une ligne N/C (celles d'un projecteur affecté sont dans show_gels)
}

/** Courbes de gradateur (plusieurs choix possibles ; « linéaire » est la valeur de base). */
export const CURVES: { k: string; label: string }[] = [
  { k: 'lineaire', label: 'Linéaire' }, { k: 'onoff', label: 'Off/On' }, { k: 'autre', label: 'Autre' }, { k: 'direct', label: 'DIRECT' }
];
export const ACCESSORIES: { k: string; label: string }[] = [
  { k: 'iris', label: 'Iris' }, { k: 'gobo', label: 'Gobo' }, { k: 'volets', label: 'Volets' }, { k: 'autre', label: 'Autre' }
];
/** Positions proposées, dans l'ordre d'usage (sert aussi au tri). */
export const POSITIONS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'mezza J', 'mezza C', 'allemande J', 'allemande C', 'passerelle J', 'passerelle C', 'corbeille', 'balcon', '3e', 'sol', 'coupole', 'autre'];

/** Colonnes, dans l'ordre d'affichage. */
export type Col = 'circuit' | 'dimmer' | 'curve' | 'dmx' | 'id' | 'model' | 'gels' | 'accessories' | 'position' | 'focus' | 'notes';
export const COLS: { k: Col; label: string }[] = [
  { k: 'circuit', label: 'Circuit' }, { k: 'model', label: 'Modèle' }, { k: 'dimmer', label: 'Grada' }, { k: 'curve', label: 'Courbe' }, { k: 'dmx', label: 'DMX' }, { k: 'id', label: 'ID' },
  { k: 'gels', label: 'Gélatines' }, { k: 'accessories', label: 'Accessoires' }, { k: 'position', label: 'Position' },
  { k: 'focus', label: 'Focus' }, { k: 'notes', label: 'Notes' }
];

/** Une ligne affichée : ce qui est enregistré + ce qui vient du matériel (modèle, gélatines). */
export interface PatchRow {
  key: string;                // identifiant stable de la ligne (« i12 » pour le projecteur 12, « l<uuid> » pour une ligne N/C)
  lineId: string | null;      // ligne en base (nulle tant que rien n'a été saisi)
  itemId: number | null;
  circuit: string; dimmer: string; curve: string[]; dmx: string; model: string; gels: string[]; gelIds: string[]; auto: boolean; accessories: string[]; position: string; focus: boolean; notes: string;
  updatedAt: string | null; updatedBy: string | null;
  externalId: string | null; extNote: string;   // location / prêt auquel la ligne est rattachée, et sa mention (« loué chez X »)
  modelId: string | null; lampId: string | null; par: boolean;   // modèle et lampe voulus (projecteur affecté : ceux du spectacle ; ligne N/C : ceux choisis)
}

/** Lignes de la feuille : un projecteur affecté = une ligne (même sans saisie), puis les lignes N/C. */
export function buildRows(data: Data, showId: string, lines: PatchLine[]): PatchRow[] {
  const mine = lines.filter((l) => l.show_id === showId);
  const rows: PatchRow[] = [];
  for (const si of data.showItems.filter((x) => x.show_id === showId)) {
    const it = data.items.find((i) => i.id === si.item_id); if (!it) continue;
    const ds = describe(data, it);
    const lamp = data.lamps.find((l) => l.id === (si.lamp_id ?? it.lamp_id))?.name;   // lampe requise, sinon lampe montée
    const par = /^PAR/i.test(ds.type?.name ?? '');
    const l = mine.find((x) => x.item_id === si.item_id);
    const gl = data.showGels.filter((g) => g.show_id === showId && g.item_id === si.item_id).sort((a, b) => a.ref.localeCompare(b.ref, 'fr', { numeric: true }));
    const row = fromLine(l ?? null, `i${si.item_id}`, si.item_id, `${ds.model?.name ?? '?'}${par && lamp ? ' ' + lamp : ''}`, gl.map((g) => g.ref));
    row.modelId = it.model_id; row.par = par; row.lampId = par ? (si.lamp_id ?? it.lamp_id) : null;
    row.gelIds = gl.map((g) => g.id); row.auto = !!si.demand_id;   // gélatines modifiables une à une ; projecteur issu d'une demande = ni retrait ni remplacement par un autre modèle
    rows.push(row);
  }
  for (const l of mine.filter((x) => x.item_id === null)) {
    const m = data.models.find((x) => x.id === l.model_id), par = /^PAR/i.test(data.types.find((t) => t.id === m?.type_id)?.name ?? '');
    const lampName = par ? data.lamps.find((x) => x.id === l.lamp_id)?.name : undefined;
    const row = fromLine(l, `l${l.id}`, null, m ? `${m.name}${lampName ? ' ' + lampName : ''}` : l.model_text, (l.gels ?? []).map((g) => g.ref));
    row.gelIds = row.gels;   // pour une ligne N/C, une gélatine se retire par sa référence
    row.modelId = m?.id ?? null; row.par = par; row.lampId = par ? l.lamp_id ?? null : null;
    const ex = data.showExternals.find((e) => e.id === l.external_id && e.show_id === showId);   // location supprimée : la ligne reste, sans mention
    if (ex) { row.externalId = ex.id; row.extNote = `${ex.kind === 'pret' ? 'prêté par' : 'loué chez'} ${ex.provider}`; }
    rows.push(row);
  }
  return rows;
}
function fromLine(l: PatchLine | null, key: string, itemId: number | null, model: string, gels: string[]): PatchRow {
  return {
    key, lineId: l?.id ?? null, itemId, model, gels, gelIds: [], auto: false, externalId: null, extNote: '', modelId: null, lampId: null, par: false,
    circuit: l?.circuit ?? '', dimmer: l?.dimmer ?? '', curve: l?.curve ?? ['lineaire'], dmx: l?.dmx ?? '', accessories: l?.accessories ?? [],
    position: l?.position ?? '', focus: l?.focus ?? false, notes: l?.notes ?? '', updatedAt: l?.updated_at ?? null, updatedBy: l?.updated_by_label ?? null
  };
}

/** Comparaison « naturelle » : 2 avant 10, G7 avant G12. */
const nat = (a: string, b: string): number => a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' });
/** Adresse DMX « univers-adresse » en nombre comparable (univers d'abord). */
export const dmxRank = (s: string): number => { const m = /^(\d+)-(\d+)$/.exec(s); return m ? Number(m[1]) * 1000 + Number(m[2]) : Infinity; };

/** Trie les lignes sur une colonne ; les cases vides passent toujours en dernier ; égalité → numéro d'ID. */
export function sortRows(rows: PatchRow[], col: Col, dir: 1 | -1): PatchRow[] {
  const empty = (r: PatchRow): boolean => {
    switch (col) {
      case 'circuit': return !r.circuit; case 'dimmer': return !r.dimmer; case 'dmx': return !r.dmx; case 'id': return r.itemId === null;
      case 'model': return !r.model; case 'gels': return !r.gels.length; case 'accessories': return !r.accessories.length;
      case 'position': return !r.position; case 'notes': return !r.notes; case 'curve': return !r.curve.length; case 'focus': return false;
    }
  };
  const cmp = (a: PatchRow, b: PatchRow): number => {
    switch (col) {
      case 'circuit': return nat(a.circuit, b.circuit); case 'dimmer': return nat(a.dimmer, b.dimmer); case 'dmx': return dmxRank(a.dmx) - dmxRank(b.dmx);
      case 'id': return (a.itemId ?? 0) - (b.itemId ?? 0); case 'model': return nat(a.model, b.model);
      case 'gels': return nat(a.gels.join(' '), b.gels.join(' ')); case 'accessories': return nat(a.accessories.join(' '), b.accessories.join(' '));
      case 'position': return POSITIONS.indexOf(a.position) - POSITIONS.indexOf(b.position); case 'notes': return nat(a.notes, b.notes);
      case 'curve': return nat(a.curve.join(' '), b.curve.join(' ')); case 'focus': return Number(b.focus) - Number(a.focus);   // focalisés d'abord (sens croissant)
    }
  };
  return [...rows].sort((a, b) => {
    const ea = empty(a), eb = empty(b);
    if (ea !== eb) return ea ? 1 : -1;
    return (ea ? 0 : cmp(a, b) * dir) || ((a.itemId ?? 1e9) - (b.itemId ?? 1e9)) || a.key.localeCompare(b.key);
  });
}

/** Colonnes qu'on peut modifier selon le rôle : technicien = grada, courbe et gélatines ; régisseur assigné / RG / admin = tout (dont l'ID). */
export function editableCols(actor: boolean, technician: boolean): Set<Col> {
  if (actor) return new Set<Col>(['circuit', 'dimmer', 'curve', 'dmx', 'id', 'model', 'gels', 'accessories', 'position', 'focus', 'notes']);
  return technician ? new Set<Col>(['dimmer', 'curve', 'gels']) : new Set<Col>();
}

/** Texte lisible des choix multiples (courbe, accessoires). */
export const labelsOf = (list: { k: string; label: string }[], vals: string[]): string => list.filter((x) => vals.includes(x.k)).map((x) => x.label).join(' · ');

/** Locations / prêts du spectacle avec leur compteur : « 3 lignes placées sur 4 ». Information seulement (rien n'est bloqué). */
export interface ExtStatus { id: string; label: string; short: string; tag: string; qty: number; placed: number }
export function externalStatus(data: Data, showId: string, lines: PatchLine[]): ExtStatus[] {
  return data.showExternals.filter((e) => e.show_id === showId).map((e) => {
    const d = data.showDemands.find((x) => x.id === e.demand_id);
    const model = data.models.find((m) => m.id === d?.model_id)?.name ?? '?', lamp = data.lamps.find((l) => l.id === d?.lamp_id)?.name;
    const short = `${model}${lamp ? ' ' + lamp : ''} · ${e.kind === 'pret' ? 'prêté par' : 'loué chez'} ${e.provider}`;
    const placed = lines.filter((l) => l.show_id === showId && l.item_id === null && l.external_id === e.id).length;
    return { id: e.id, label: short, short, tag: `${e.kind === 'pret' ? 'Prêt' : 'Loc.'} ${e.provider}`, qty: e.qty, placed };
  }).sort((a, b) => a.short.localeCompare(b.short, 'fr', { numeric: true }));
}
/** Texte du compteur d'une location : « 3/4 », avec « il en manque 1 » ou « 1 en trop ». */
export const extCount = (x: ExtStatus): string => `${x.placed}/${x.qty}${x.placed < x.qty ? ` · il en manque ${x.qty - x.placed}` : x.placed > x.qty ? ` · ${x.placed - x.qty} en trop` : ' ✓'}`;
