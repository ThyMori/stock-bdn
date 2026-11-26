// Jeu caché « Invasion » : atteint en touchant 5 fois le numéro de version (Plus). Réservé aux régisseurs et plus ; classement = meilleur score de chacun.
import type { ViewFactory } from '../router';
import { can, state } from '../store';
import { supabase } from '../supabase';
import { confirmBox } from '../ui/dialog';
import { toast } from '../ui/toast';
import { friendlyError, isNetworkMessage } from '../netError';
import { H, SHIP_Y, W, newGame, step } from '../invaders';
import type { Game, Input } from '../invaders';

// Dessins des ennemis (8 × 6 « pixels », agrandis ×2) : un projecteur à lentille (PAR), un Fresnel (PC), une découpe. Dessins originaux.
const SPRITES: string[][] = [
  ['..#..#..', '.######.', '########', '#.#..#.#', '########', '.#....#.'],   // découpe (rangée du haut)
  ['########', '#......#', '#.####.#', '#.####.#', '#......#', '##.##.##'],   // Fresnel (PC)
  ['..####..', '.#....#.', '#.####.#', '#.####.#', '.#....#.', '..####..']    // PAR
];
const SHIP = ['....##....', '...####...', '..######..', '.########.', '##########', '##########'];   // projecteur de poursuite
const spriteOf = (row: number) => SPRITES[row === 0 ? 0 : row <= 2 ? 1 : 2];
const PENDING = 'stockbdn.game.pending';                              // score à envoyer quand la connexion revient

const readPending = (): number => { try { return Number(localStorage.getItem(PENDING)) || 0; } catch { return 0; } };
const writePending = (v: number) => { try { if (v > 0) localStorage.setItem(PENDING, String(v)); else localStorage.removeItem(PENDING); } catch { /* navigation privée : on ignore */ } };

interface Row { user_id: string; label: string; score: number; level: number }

export const gameView: ViewFactory = () => ({
  mount(root) {
    root.innerHTML = `<div class="page stack"><a href="#/more" class="sub">‹ Plus</a><h1>Invasion</h1>
      <div class="game-hud" role="status" aria-live="off"><span id="g-score">Score 0</span><span id="g-lives">♥♥♥</span><span id="g-level">Niv. 1</span></div>
      <canvas id="cv" class="game-canvas" aria-label="Terrain de jeu : des projecteurs envahissent le plateau" role="img"></canvas>
      <div class="row"><button class="btn primary grow" id="play">Jouer</button><button class="btn grow" id="fire" aria-label="Tirer">TIR</button></div>
      <div class="sub">Ordinateur : ← → pour bouger, espace pour tirer. Téléphone : glisse le doigt sur le terrain, appuie sur TIR (maintiens pour tirer en continu).</div>
      <div class="card stack"><h2>Classement</h2><div class="sub">Le meilleur score de chaque personne.</div><ol id="board" class="game-board"></ol><div id="bmsg" class="sub" role="status"></div></div></div>`;
    const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
    const cv = $<HTMLCanvasElement>('#cv'), ctx = cv.getContext('2d')!;
    const css = getComputedStyle(cv), col = (n: string) => css.getPropertyValue(n).trim() || '#fff';   // couleurs prises dans les variables CSS
    let g: Game = newGame(), mode: 'ready' | 'play' | 'over' = 'ready', paused = false, raf = 0, last = 0, acc = 0;
    const input: Input = { move: 0, target: null, fire: false };
    const keys = new Set<string>();
    const me = state.session?.user.id ?? '';

    // taille du dessin : suit la largeur de l'écran, avec une définition adaptée aux écrans nets
    const fit = () => { const r = cv.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 3); cv.width = Math.round(r.width * d); cv.height = Math.round(r.width * d * H / W); };
    const sprite = (rows: string[], cx: number, cy: number, px: number, color: string, wob = 0) => {
      ctx.fillStyle = color; const w = rows[0].length * px, h = rows.length * px;
      rows.forEach((line, y) => [...line].forEach((c, x) => { if (c === '#') ctx.fillRect(Math.round(cx - w / 2 + x * px + (y > 3 ? wob : 0)), Math.round(cy - h / 2 + y * px), px, px); }));
    };
    const draw = () => {
      const k = cv.width / W; ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.fillStyle = col('--game-bg'); ctx.fillRect(0, 0, W, H);
      const wob = Math.floor(g.t * 2) % 2;                          // petit balancement des ennemis, deux fois par seconde
      for (const a of g.aliens) if (a.alive) sprite(spriteOf(a.row), a.x, a.y, 2, col(a.row === 0 ? '--game-c' : a.row <= 2 ? '--game-b' : '--game-a'), wob);
      if (g.invulnerable === 0 || Math.floor(g.t * 12) % 2 === 0) { sprite(SHIP, g.ship.x, SHIP_Y, 2, col('--game-ship')); }
      ctx.fillStyle = col('--game-ship'); for (const s of g.shots) ctx.fillRect(s.x - 1, s.y - 4, 2, 8);
      ctx.fillStyle = col('--game-bomb'); for (const b of g.bombs) { ctx.fillRect(b.x - 2, b.y - 4, 4, 8); ctx.fillRect(b.x - 1, b.y + 4, 2, 2); }
      for (const c of g.shields) { ctx.fillStyle = col('--game-shield'); ctx.globalAlpha = c.hp > 1 ? 1 : 0.5; ctx.fillRect(c.x - 2, c.y - 2, 4, 4); } ctx.globalAlpha = 1;   // boucliers : demi-teinte quand ils sont abîmés
      ctx.fillStyle = col('--game-ship'); ctx.fillRect(0, SHIP_Y + 12, W, 1);   // ligne du plateau
      if (mode !== 'play') {
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = col('--game-ship'); ctx.textAlign = 'center';
        ctx.font = 'bold 22px sans-serif'; ctx.fillText(mode === 'over' ? 'FIN DE PARTIE' : 'INVASION', W / 2, H / 2 - 8);
        ctx.font = '14px sans-serif'; ctx.fillText(mode === 'over' ? `Score ${g.score}` : 'Appuie sur « Jouer »', W / 2, H / 2 + 16);
      } else if (paused) { ctx.fillStyle = col('--game-ship'); ctx.textAlign = 'center'; ctx.font = 'bold 18px sans-serif'; ctx.fillText('PAUSE', W / 2, H / 2); }
    };
    const hud = () => { $('#g-score').textContent = `Score ${g.score}`; $('#g-lives').textContent = '♥'.repeat(Math.max(0, g.lives)) || '–'; $('#g-level').textContent = `Niv. ${g.level}`; };

    // ---- classement
    const board = $('#board'), bmsg = $('#bmsg');
    const loadBoard = async () => {
      const r = await supabase.from('game_scores').select('user_id,label,score,level').order('score', { ascending: false }).limit(20);
      if (r.error) { bmsg.textContent = isNetworkMessage(r.error.message) ? friendlyError(r.error.message, true) : 'Classement indisponible pour le moment.'; board.replaceChildren(); return; }
      bmsg.textContent = r.data.length ? '' : 'Personne n\'a encore joué : sois le premier !';
      board.replaceChildren(...(r.data as Row[]).map((x, i) => {
        const li = document.createElement('li'); if (x.user_id === me) li.className = 'me';
        const t = document.createElement('span'); t.className = 'grow'; t.textContent = `${i + 1}. ${x.label}`;
        const s = document.createElement('b'); s.textContent = `${x.score}`; const lv = document.createElement('span'); lv.className = 'sub'; lv.textContent = ` niv. ${x.level}`;
        li.append(t, s, lv);
        if (can('admin')) {                                         // l'administrateur peut retirer un score
          const d = document.createElement('button'); d.type = 'button'; d.className = 'chip'; d.textContent = '✕'; d.setAttribute('aria-label', `Supprimer le score de ${x.label}`);
          d.addEventListener('click', async () => { if (!await confirmBox(`Supprimer le score de ${x.label} (${x.score}) ?`)) return; const e = await supabase.rpc('delete_score', { p_user: x.user_id }); if (e.error) toast(friendlyError(e.error.message, true)); else void loadBoard(); });
          li.append(d);
        }
        return li;
      }));
    };
    /** Envoie un score ; hors ligne ou réseau coupé, il est gardé et renvoyé plus tard. */
    const submit = async (score: number, level: number) => {
      if (score <= 0) return;
      if (!navigator.onLine) { writePending(Math.max(score, readPending())); toast('Hors ligne : ton score sera envoyé au retour de la connexion.'); return; }
      const r = await supabase.rpc('submit_score', { p_score: score, p_level: level });
      if (r.error) { if (isNetworkMessage(r.error.message)) { writePending(Math.max(score, readPending())); toast(friendlyError(r.error.message, true)); } else toast(r.error.message); return; }
      writePending(0); const d = r.data as { best: number; improved: boolean; rank: number };
      toast(d.improved ? `Nouveau record personnel : ${d.best} (n° ${d.rank} au classement) !` : `Ton record reste ${d.best} (n° ${d.rank}).`, 'ok'); void loadBoard();
    };

    // ---- boucle de jeu : pas fixe de 1/60 s
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (mode === 'play' && !paused) {
        acc += dt;
        while (acc >= 1 / 60) { input.move = (keys.has('ArrowRight') || keys.has('d') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('q') || keys.has('a') ? 1 : 0) as -1 | 0 | 1; step(g, 1 / 60, input, Math.random); acc -= 1 / 60; if (g.over) break; }
        hud();
        if (g.over) { mode = 'over'; $('#play').textContent = 'Rejouer'; void submit(g.score, g.level); }
      }
      draw();
    };
    const start = () => { g = newGame(); mode = 'play'; paused = false; acc = 0; hud(); $('#play').textContent = 'Recommencer'; };
    $('#play').addEventListener('click', start);
    // clavier
    const kd = (e: KeyboardEvent) => { if (['ArrowLeft', 'ArrowRight', ' '].includes(e.key) && mode === 'play') e.preventDefault(); keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key); if (e.key === ' ') input.fire = true; };
    const ku = (e: KeyboardEvent) => { keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); if (e.key === ' ') input.fire = false; };
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
    // doigt / souris sur le terrain : le vaisseau suit
    const tgt = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); input.target = Math.max(0, Math.min(W, (e.clientX - r.left) / r.width * W)); };
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); tgt(e); }); cv.addEventListener('pointermove', (e) => { if (input.target !== null) tgt(e); });
    const release = () => { input.target = null; }; cv.addEventListener('pointerup', release); cv.addEventListener('pointercancel', release);
    const fb = $('#fire'); fb.addEventListener('pointerdown', (e) => { e.preventDefault(); input.fire = true; }); for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) fb.addEventListener(ev, () => { input.fire = false; });
    const vis = () => { paused = document.hidden && mode === 'play'; }; document.addEventListener('visibilitychange', vis);
    const online = () => { const p = readPending(); if (p > 0) void submit(p, 1); }; window.addEventListener('online', online);
    window.addEventListener('resize', fit); fit(); hud(); draw(); void loadBoard(); online();
    raf = requestAnimationFrame((t) => { last = t; frame(t); });
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('resize', fit); window.removeEventListener('online', online); document.removeEventListener('visibilitychange', vis); };
  }
});
