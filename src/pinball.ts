// Animation « flipper d'arcade années 80 » : EXTRA !!! — jouée 1 seconde à l'ouverture de l'onglet Plus.

const W = 192, H = 108, MS = 1000;
const GLYPH: Record<string, string[]> = {
  E: ['1111', '1000', '1000', '1110', '1000', '1000', '1111'],
  X: ['1001', '1001', '0110', '0110', '0110', '1001', '1001'],
  T: ['1111', '0110', '0110', '0110', '0110', '0110', '0110'],
  R: ['1110', '1001', '1001', '1110', '1010', '1001', '1001'],
  A: ['0110', '1001', '1001', '1111', '1001', '1001', '1001'],
  '!': ['1', '1', '1', '1', '1', '0', '1']
};
const NEON = ['#18e0ff', '#ffd500', '#ff2fd0', '#ffffff'];

export function playPinball(done: () => void): void {
  const box = document.createElement('div');
  box.className = 'arc-fx'; box.setAttribute('aria-hidden', 'true');
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  box.appendChild(cv); document.body.appendChild(box);
  const g = cv.getContext('2d')!;
  const rect = (x: number, y: number, w: number, h: number, c: string) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };
  const disc = (cx: number, cy: number, r: number, c: string) => {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.4) rect(cx + x, cy + y, 1, 1, c);
  };
  const text = (t: string, x: number, y: number, c: string, s: number) => {
    let cx = x;
    for (const ch of t) { const gl = GLYPH[ch]; if (!gl) continue;
      gl.forEach((row, ry) => [...row].forEach((v, rx) => { if (v === '1') rect(cx + rx * s, y + ry * s, s, s, c); }));
      cx += (gl[0].length + 1) * s; }
  };
  const width = (t: string, s: number) => [...t].reduce((a, ch) => a + (GLYPH[ch][0].length + 1) * s, 0) - s;

  const bumpers = [{ x: 30, y: 80 }, { x: 96, y: 94 }, { x: 162, y: 80 }];
  const t0 = performance.now();
  let raf = 0, finished = false;

  function frame(now: number) {
    const t = now - t0; if (t >= MS) return finish();
    const f = Math.floor(t / 50);
    rect(0, 0, W, H, '#07041f');
    // fond : étoiles qui scintillent
    for (let i = 0; i < 40; i++) { const x = (i * 53) % W, y = (i * 29) % H; if ((f + i) % 4 < 2) rect(x, y, 1, 1, '#3a2f8a'); }
    // bille : rebonds
    const bx = 96 + Math.sin(t / 95) * 78, by = 62 + Math.abs(Math.sin(t / 130)) * 36 - 18 + Math.sin(t / 47) * 3;
    // bumpers : s'allument quand la bille les touche
    for (const b of bumpers) {
      const hit = Math.hypot(bx - b.x, by - b.y) < 17;
      disc(b.x, b.y, 11, hit ? '#fff' : '#b0102a'); disc(b.x, b.y, 8, hit ? '#ffd500' : '#ff3b30'); disc(b.x, b.y, 3, hit ? '#fff' : '#ffd500');
      if (hit) for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 + f; rect(b.x + Math.cos(a) * 16, b.y + Math.sin(a) * 16, 2, 2, '#ffd500'); }
    }
    // EXTRA !!! : néon qui pulse
    const pulse = f % 6 < 3 ? 1 : 0;
    const c = NEON[f % NEON.length];
    const wE = width('EXTRA', 5), xE = Math.round((W - wE) / 2);
    text('EXTRA', xE + 2, 13 + 2, '#5a1380', 5);      // ombre
    text('EXTRA', xE, 13, pulse ? '#ffffff' : c, 5);
    const w3 = width('!!!', 4), x3 = Math.round((W - w3) / 2);
    if (f % 4 < 3) { text('!!!', x3 + 2, 52 + 2, '#5a1380', 4); text('!!!', x3, 52, NEON[(f + 1) % NEON.length], 4); }
    // traînée + bille chromée
    for (let k = 4; k >= 1; k--) disc(bx - Math.cos(t / 95) * k * 3, by + k, 3, `rgba(200,220,255,${0.12 * (5 - k)})`);
    disc(bx, by, 4, '#cfd8ff'); rect(bx - 2, by - 2, 2, 2, '#fff');
    // guirlande d'ampoules qui chenille
    for (let x = 4; x < W; x += 8) for (const y of [3, H - 5]) rect(x, y, 3, 3, ((x >> 3) + f) % 3 === 0 ? '#ffd500' : '#7a1a1a');
    for (let y = 11; y < H - 8; y += 8) for (const x of [3, W - 6]) rect(x, y, 3, 3, ((y >> 3) + f) % 3 === 0 ? '#ffd500' : '#7a1a1a');
    // balayage CRT + fondu
    for (let y = 0; y < H; y += 2) rect(0, y, W, 1, 'rgba(0,0,0,0.25)');
    if (t > MS - 150) rect(0, 0, W, H, `rgba(0,0,0,${(t - (MS - 150)) / 150})`);
    raf = requestAnimationFrame(frame);
  }
  function finish() { if (finished) return; finished = true; cancelAnimationFrame(raf); box.remove(); done(); }
  box.addEventListener('click', finish);
  raf = requestAnimationFrame(frame);
}
