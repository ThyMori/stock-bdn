// Largeur des colonnes de la feuille de patch, réglable à la souris sur ordinateur et mémorisée sur cet appareil.
// Les fonctions « pures » (limites, génération du CSS) sont testées dans tests/logic.test.ts.
export type Widths = Record<string, number>;
const KEY = 'stockbdn.patchcols';          // clé de mémorisation (localStorage)
export const MIN_W = 40, MAX_W = 700;       // largeur mini / maxi d'une colonne, en pixels
const COLS_OK = ['circuit', 'dimmer', 'curve', 'dmx', 'id', 'model', 'gels', 'accessories', 'position', 'state', 'notes'];

/** Ramène une largeur dans les limites (nombre entier de pixels). */
export const clampW = (w: number): number => Math.round(Math.min(MAX_W, Math.max(MIN_W, w)));

/** Ne garde que les colonnes connues et des largeurs valides (une valeur abîmée est ignorée). */
export function cleanWidths(raw: unknown): Widths {
  const out: Widths = {};
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (COLS_OK.includes(k) && typeof v === 'number' && isFinite(v)) out[k] = clampW(v);
  return out;
}

/** CSS qui impose les largeurs choisies. Réservé aux grands écrans avec souris : sur téléphone, la feuille garde son réglage (circuit + modèle = 1/3 de l'écran). */
export function colCss(w: Widths): string {
  const rules = Object.entries(w).map(([k, px]) => k === 'circuit'
    ? `table.patch { --cw: ${px}px; }`
    : `table.patch th[data-c="${k}"], table.patch td[data-c="${k}"] { width: ${px}px; min-width: ${px}px; max-width: ${px}px; box-sizing: border-box; }
       table.patch td[data-c="${k}"] .pin, table.patch td[data-c="${k}"] .idcell, table.patch td[data-c="${k}"] .idsel, table.patch td[data-c="${k}"] details.multi { width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; }`);
  return rules.length ? `@media (min-width: 1001px) and (hover: hover) { ${rules.join('\n')} }` : '';
}

/** Relit les largeurs mémorisées (stockage indisponible ou abîmé : réglage automatique). */
export function loadWidths(): Widths { try { return cleanWidths(JSON.parse(localStorage.getItem(KEY) ?? '{}')); } catch { return {}; } }
/** Mémorise les largeurs (silencieux si le stockage est indisponible). */
export function saveWidths(w: Widths): void { try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { /* stockage refusé : tant pis */ } }
