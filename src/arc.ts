// Petite animation « arcade années 80 » : un câble sectionné et son arc électrique.
// Jouée quand on ouvre l'onglet Pannes. Désactivée si l'appareil demande moins d'animations.

const W = 192, H = 108, MS = 1000;
const GLYPH: Record<string, string[]> = {
  P: ['1110', '1001', '1001', '1110', '1000', '1000', '1000'],
  A: ['0110', '1001', '1001', '1111', '1001', '1001', '1001'],
  N: ['1001', '1101', '1101', '1011', '1011', '1001', '1001'],
  E: ['1111', '1000', '1000', '1110', '1000', '1000', '1111'],
  '!': ['1', '1', '1', '1', '1', '0', '1']
};

export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Joue l'animation en plein écran puis appelle done(). Un toucher l'interrompt. */
export function playArc(done: () => void): void {
  const box = document.createElement('div');
  box.className = 'arc-fx'; box.setAttribute('aria-hidden', 'true');
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  box.appendChild(cv); document.body.appendChild(box);
  const g = cv.getContext('2d')!;
  const px = (x: number, y: number, c: string, s = 1) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), s, s); };
  const rect = (x: number, y: number, w: number, h: number, c: string) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };
  const text = (t: string, x: number, y: number, c: string, s: number) => {
    let cx = x;
    for (const ch of t) { const gl = GLYPH[ch]; if (!gl) { cx += 3 * s; continue; }
      gl.forEach((row, ry) => [...row].forEach((v, rx) => { if (v === '1') rect(cx + rx * s, y + ry * s, s, s, c); }));
      cx += (gl[0].length + 1) * s; }
  };

  const GAP_L = 78, GAP_R = 114, Y = 56;
  const sparks: { x: number; y: number; vx: number; vy: number; life: number; c: string }[] = [];
  const t0 = performance.now();
  let raf = 0, finished = false;

  const cable = (x0: number, x1: number, sag: number, jit: number) => {
    for (let x = x0; x <= x1; x++) {
      const k = (x - x0) / (x1 - x0 || 1);
      const y = Y + Math.sin(k * Math.PI * 2 + sag) * 4 * (1 - k) + (Math.random() < jit ? 1 : 0);
      rect(x, y - 2, 1, 5, '#3a1d0f');       // contour
      rect(x, y - 1, 1, 3, '#ff6a1a');       // gaine
      px(x, y - 1, '#ffb066');                // reflet
      if ((x >> 2) % 5 === 0) rect(x, y - 1, 1, 3, '#ffd500'); // bagues
    }
  };

  function bolt(x0: number, x1: number, y: number, amp: number): [number, number][] {
    const pts: [number, number][] = [[x0, y]]; const n = 9;
    for (let i = 1; i < n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y + (Math.random() * 2 - 1) * amp]);
    pts.push([x1, y]); return pts;
  }
  function stroke(pts: [number, number][], c: string, s: number) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1]; const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
      for (let k = 0; k <= n; k++) px(ax + ((bx - ax) * k) / n - (s >> 1), ay + ((by - ay) * k) / n - (s >> 1), c, s);
    }
  }

  function frame(now: number) {
    const t = now - t0; if (t >= MS) return finish();
    const f = Math.floor(t / 50);              // 20 images/s, façon borne d'arcade
    const on = Math.sin(t / 55) > -0.6;        // l'arc crépite
    rect(0, 0, W, H, '#05000d');
    // fond : grille perspective violette
    for (let i = 0; i < 12; i++) rect(0, 66 + i * i * 0.35 + 2, W, 1, '#2a0a4a');
    for (let i = -8; i <= 8; i++) { const x0 = W / 2 + i * 4, x1 = W / 2 + i * 22;
      for (let k = 0; k <= 1; k += 0.04) px(x0 + (x1 - x0) * k, 66 + k * 42, '#2a0a4a'); }
    if (on && f % 3 === 0) rect(0, 0, W, H, 'rgba(120,200,255,0.10)'); // éclair d'ambiance
    // câbles
    cable(0, GAP_L - 6, f * 0.6, 0.08); cable(GAP_R + 6, W - 1, -f * 0.6, 0.08);
    // embouts cuivre
    for (const [x, d] of [[GAP_L - 6, 1], [GAP_R + 6, -1]] as const) {
      rect(x, Y - 3, d * 3, 7, '#8a8a99'); rect(x + d * 3, Y - 1, d * 6, 3, '#e0a040'); px(x + d * 6, Y, '#fff3b0'); }
    // arc
    const gl = on ? 1 : 0;
    if (gl) {
      const amp = 4 + Math.random() * 5; const x0 = GAP_L + 3, x1 = GAP_R - 3;
      const main = bolt(x0, x1, Y, amp);
      stroke(main, '#c01bff', 5); stroke(main, '#18e0ff', 3); stroke(main, '#ffffff', 1);
      if (Math.random() < 0.7) { const b = bolt(x0 + 10, x1 - 10, Y + (Math.random() < .5 ? -10 : 10), 6); stroke(b, '#18e0ff', 1); }
      for (let i = 0; i < 4; i++) sparks.push({ x: GAP_L + 6 + Math.random() * 24, y: Y, vx: (Math.random() - 0.5) * 3, vy: -Math.random() * 2.4 - 0.4, life: 14 + Math.random() * 10, c: Math.random() < .5 ? '#ffd500' : '#ffffff' });
    }
    for (let i = sparks.length - 1; i >= 0; i--) { const s = sparks[i];
      s.x += s.vx; s.y += s.vy; s.vy += 0.16; s.life--; if (s.life <= 0 || s.y > H) { sparks.splice(i, 1); continue; }
      px(s.x, s.y, s.life < 5 ? '#ff6a1a' : s.c, 2); }
    // texte
    const blink = f % 8 < 5;
    text('PANNE !', 56, 14, blink ? '#ff3b30' : '#ffd500', 3);
    text('PANNE !', 57, 15, 'rgba(0,0,0,0)', 3);
    // balayage CRT
    for (let y = 0; y < H; y += 2) rect(0, y, W, 1, 'rgba(0,0,0,0.28)');
    // fondu de sortie
    if (t > MS - 200) rect(0, 0, W, H, `rgba(0,0,0,${(t - (MS - 200)) / 200})`);
    raf = requestAnimationFrame(frame);
  }
  function finish() {
    if (finished) return; finished = true; cancelAnimationFrame(raf); box.remove(); done();
  }
  box.addEventListener('click', finish);
  raf = requestAnimationFrame(frame);
}
