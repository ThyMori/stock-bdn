// Petits outils « à la main » pour les PDF façon feuille de cahier : tremblé des traits et décalage des écritures.
// Tout est déterministe (même résultat à chaque génération) et sans accès à l'écran : testé dans tests/logic.test.ts.

/** Nombre pseudo-aléatoire stable, entre -1 et 1, calculé à partir d'une graine (mêmes graines = mêmes valeurs). */
export function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;   // formule classique : fraction d'un grand sinus
  return (x - Math.floor(x)) * 2 - 1;                          // ramenée entre -1 et 1
}

/** Points d'un trait « tracé à la main » entre deux extrémités : tous les `step` mm, le trait s'écarte un peu (± `amp` mm) de la droite parfaite.
 *  Le premier et le dernier point restent exactement aux extrémités demandées. */
export function wobblePoints(x1: number, y1: number, x2: number, y2: number, amp = 0.25, step = 9, seed = 1): [number, number][] {
  const len = Math.hypot(x2 - x1, y2 - y1), n = Math.max(1, Math.round(len / step));
  const nx = len ? -(y2 - y1) / len : 0, ny = len ? (x2 - x1) / len : 0;   // direction perpendiculaire au trait
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, j = i === 0 || i === n ? 0 : noise(seed + i * 7.31) * amp;
    pts.push([x1 + (x2 - x1) * t + nx * j, y1 + (y2 - y1) * t + ny * j]);
  }
  return pts;
}
