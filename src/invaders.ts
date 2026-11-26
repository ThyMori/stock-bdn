// Jeu caché : une invasion de projecteurs. Logique pure (aucun écran, aucun réseau), avec un pas de temps fixe, donc testable.
export const W = 240, H = 320;                                   // taille logique du terrain (le dessin s'adapte à l'écran)
export const SHIP_Y = H - 26, SHIP_W = 22, ALIEN_W = 16, ALIEN_H = 12, COLS = 8, ROWS = 5;
export const ROW_POINTS = [30, 20, 20, 10, 10];                  // points par rangée (du haut vers le bas)

export interface Alien { x: number; y: number; row: number; alive: boolean }
export interface Shot { x: number; y: number }
/** Un bloc de bouclier (4 × 4) : 2 points de résistance ; il s'efface quand il est touché deux fois. */
export interface Cell { x: number; y: number; hp: number }
export const CELL = 4;
const BUNKER = ['..####..', '.######.', '########', '########', '##....##'];   // forme d'un bouclier (8 × 5 blocs)
export interface Game {
  ship: { x: number }; shots: Shot[]; bombs: Shot[]; aliens: Alien[]; shields: Cell[];
  dir: 1 | -1; lives: number; score: number; level: number; over: boolean;
  cooldown: number; invulnerable: number; t: number; wave: boolean;   // wave : une nouvelle vague vient d'arriver (pour l'affichage)
}
export interface Input { move: -1 | 0 | 1; target: number | null; fire: boolean }   // target : position voulue du vaisseau (doigt), sinon null

/** Une vague d'ennemis : COLS × ROWS, qui démarre plus bas à chaque niveau (jusqu'à une limite). */
export function newWave(level: number): Alien[] {
  const out: Alien[] = [], top = 28 + Math.min(level - 1, 5) * 6;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) out.push({ x: 20 + c * 24, y: top + r * 18, row: r, alive: true });
  return out;
}
/** Quatre boucliers répartis au-dessus du vaisseau (reconstruits à chaque nouvelle vague). */
export function newShields(): Cell[] {
  const out: Cell[] = [];
  for (let b = 0; b < 4; b++) BUNKER.forEach((row, r) => [...row].forEach((c, k) => { if (c === '#') out.push({ x: 30 + b * 60 + (k - 3.5) * CELL, y: SHIP_Y - 34 + r * CELL, hp: 2 }); }));
  return out;
}
export const newGame = (): Game => ({ ship: { x: W / 2 }, shots: [], bombs: [], aliens: newWave(1), shields: newShields(), dir: 1, lives: 3, score: 0, level: 1, over: false, cooldown: 0, invulnerable: 0, t: 0, wave: false });

const hit = (ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number) => Math.abs(ax - bx) * 2 < aw + bw && Math.abs(ay - by) * 2 < ah + bh;

/** Avance le jeu de `dt` secondes (appeler avec de petits pas, par exemple 1/60). `rnd` : tirage entre 0 et 1 (injecté pour les tests). */
export function step(g: Game, dt: number, inp: Input, rnd: () => number): void {
  if (g.over) return;
  g.t += dt; g.wave = false;
  g.cooldown = Math.max(0, g.cooldown - dt); g.invulnerable = Math.max(0, g.invulnerable - dt);
  // vaisseau : clavier (vitesse) ou doigt (il suit la cible, vite mais pas instantanément)
  if (inp.target !== null) { const d = inp.target - g.ship.x, m = 260 * dt; g.ship.x += Math.abs(d) <= m ? d : Math.sign(d) * m; }
  else g.ship.x += inp.move * 150 * dt;
  g.ship.x = Math.max(SHIP_W / 2, Math.min(W - SHIP_W / 2, g.ship.x));
  // tir du joueur : un faisceau toutes les 0,45 s, trois à l'écran au plus
  if (inp.fire && g.cooldown === 0 && g.shots.length < 3) { g.shots.push({ x: g.ship.x, y: SHIP_Y - 8 }); g.cooldown = 0.45; }
  for (const s of g.shots) s.y -= 260 * dt;
  g.shots = g.shots.filter((s) => s.y > -6);
  // ennemis : ils avancent de côté, descendent au bord, et accélèrent quand il en reste peu
  const alive = g.aliens.filter((a) => a.alive), total = ROWS * COLS;
  if (alive.length) {
    const speed = (18 + 5 * Math.min(g.level, 8)) * (1 + (1 - alive.length / total) * 2.4);
    const dx = g.dir * speed * dt;
    const edge = alive.some((a) => a.x + dx < ALIEN_W / 2 || a.x + dx > W - ALIEN_W / 2);
    if (edge) { g.dir = (g.dir * -1) as 1 | -1; for (const a of alive) a.y += 8; } else for (const a of alive) a.x += dx;
    // bombes : l'ennemi le plus bas d'une colonne tirée au hasard lâche un projectile
    const rate = 0.7 + 0.25 * Math.min(g.level, 8);               // bombes par seconde en moyenne
    if (rnd() < rate * dt) {
      const cols = new Map<number, Alien>();
      for (const a of alive) { const k = Math.round(a.x / 24); const c = cols.get(k); if (!c || a.y > c.y) cols.set(k, a); }
      const list = [...cols.values()]; const a = list[Math.floor(rnd() * list.length) % list.length];
      if (a) g.bombs.push({ x: a.x, y: a.y + ALIEN_H / 2 });
    }
  }
  for (const b of g.bombs) b.y += (90 + 12 * Math.min(g.level, 8)) * dt;
  g.bombs = g.bombs.filter((b) => b.y < H + 6);
  // faisceau contre ennemi
  for (const s of g.shots) for (const a of g.aliens) {
    if (a.alive && hit(s.x, s.y, 3, 8, a.x, a.y, ALIEN_W, ALIEN_H)) { a.alive = false; s.y = -100; g.score += ROW_POINTS[a.row] * 1; break; }
  }
  g.shots = g.shots.filter((s) => s.y > -50);
  // boucliers : faisceaux et bombes les abîment (et disparaissent) ; un ennemi qui les touche les efface
  const eat = (list: Shot[], w: number, h: number) => list.filter((p) => {
    const c = g.shields.find((k) => k.hp > 0 && hit(p.x, p.y, w, h, k.x, k.y, CELL, CELL));
    if (!c) return true; c.hp--; return false;
  });
  g.shots = eat(g.shots, 3, 8); g.bombs = eat(g.bombs, 4, 8);
  for (const a of g.aliens) if (a.alive) for (const c of g.shields) if (c.hp > 0 && hit(a.x, a.y, ALIEN_W, ALIEN_H, c.x, c.y, CELL, CELL)) c.hp = 0;
  g.shields = g.shields.filter((c) => c.hp > 0);
  // bombe contre vaisseau
  if (g.invulnerable === 0) {
    const b = g.bombs.find((x) => hit(x.x, x.y, 4, 8, g.ship.x, SHIP_Y, SHIP_W, 10));
    if (b) { g.lives--; g.bombs = []; g.invulnerable = 1.6; if (g.lives <= 0) { g.over = true; return; } }
  }
  // les ennemis atteignent le vaisseau : fin de partie
  if (g.aliens.some((a) => a.alive && a.y + ALIEN_H / 2 >= SHIP_Y - 6)) { g.over = true; return; }
  // vague terminée : niveau suivant, bonus, un peu plus vite
  if (!g.aliens.some((a) => a.alive)) { g.level++; g.score += 100; g.aliens = newWave(g.level); g.shields = newShields(); g.dir = 1; g.shots = []; g.bombs = []; g.wave = true; }
}
