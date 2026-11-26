import assert from 'node:assert/strict';
import { COLS, ROWS, SHIP_Y, W, newGame, newWave, step } from '../src/invaders';

const idle = { move: 0 as const, target: null, fire: false };
const none = () => 0.99;                                           // jamais de bombe

// vague : 8 × 5 ennemis, tous dans le terrain
const wv = newWave(1); assert.equal(wv.length, COLS * ROWS); assert.ok(wv.every((a) => a.x > 0 && a.x < W));
// déplacement : clavier, limites du terrain, suivi du doigt
let g = newGame(); step(g, 0.1, { ...idle, move: 1 }, none); assert.ok(g.ship.x > W / 2);
g = newGame(); for (let i = 0; i < 200; i++) step(g, 0.05, { ...idle, move: -1 }, none); assert.ok(g.ship.x >= 11); assert.ok(g.ship.x <= 12);
g = newGame(); step(g, 0.1, { ...idle, target: 40 }, none); assert.ok(g.ship.x < W / 2 && g.ship.x > 40);
// tir : un faisceau, délai de rechargement, puis il touche un ennemi (points de sa rangée)
g = newGame(); step(g, 0.01, { ...idle, fire: true }, none); assert.equal(g.shots.length, 1);
step(g, 0.01, { ...idle, fire: true }, none); assert.equal(g.shots.length, 1);                 // recharge
g = newGame(); g.aliens = g.aliens.map((a) => ({ ...a, alive: a.row === 4 && a.x === 20 })); g.ship.x = 20; g.aliens.push({ x: 200, y: 40, row: 0, alive: true });
for (let i = 0; i < 120; i++) step(g, 1 / 60, { ...idle, fire: true }, none);
assert.equal(g.score, 10); assert.ok(g.aliens.filter((a) => a.alive).length === 1);
// bombe sur le vaisseau : vie perdue, puis invulnérabilité ; trois vies = fin
g = newGame(); g.bombs.push({ x: g.ship.x, y: SHIP_Y - 2 }); step(g, 1 / 60, idle, none); assert.equal(g.lives, 2); assert.ok(g.invulnerable > 1);
g.bombs.push({ x: g.ship.x, y: SHIP_Y - 2 }); step(g, 1 / 60, idle, none); assert.equal(g.lives, 2);   // protégé un instant
g.lives = 1; g.invulnerable = 0; g.bombs.push({ x: g.ship.x, y: SHIP_Y - 2 }); step(g, 1 / 60, idle, none); assert.equal(g.over, true);
// invasion : un ennemi qui atteint le bas = fin
g = newGame(); g.aliens[0].y = SHIP_Y; step(g, 1 / 60, idle, none); assert.equal(g.over, true);
// vague terminée : niveau suivant, +100
g = newGame(); g.aliens.forEach((a) => { a.alive = false; }); g.aliens[0].alive = true; g.aliens[0].x = 100; g.aliens[0].y = 100; g.ship.x = 100;
g.shots.push({ x: g.aliens[0].x, y: g.aliens[0].y + 4 }); step(g, 1 / 60, idle, none);   // un faisceau touche le dernier ennemi
assert.equal(g.level, 2); assert.ok(g.score >= 100); assert.equal(g.aliens.filter((a) => a.alive).length, COLS * ROWS);
// les ennemis lâchent des bombes quand le hasard le veut, et accélèrent quand il en reste peu
g = newGame(); step(g, 1 / 60, idle, () => 0); assert.equal(g.bombs.length, 1);
const speedOf = (n: number) => { const h = newGame(); h.aliens.forEach((a, i) => { a.alive = i < n; }); const x0 = h.aliens[0].x; step(h, 0.1, idle, none); return h.aliens[0].x - x0; };
assert.ok(speedOf(3) > speedOf(40));
// la partie terminée ne bouge plus
g = newGame(); g.over = true; const s0 = g.t; step(g, 1, idle, none); assert.equal(g.t, s0);
console.log('invaders OK');
