// Bip « caisse enregistreuse » joué à chaque QR code lu (son synthétisé : aucun fichier à charger, marche hors ligne).
let ctx: AudioContext | null = null;   // contexte audio, créé au premier toucher de l'écran (les navigateurs l'exigent)

/** Crée / réveille le contexte audio. Appelé à chaque toucher : le son est alors prêt quand le scan lit un code. */
function prime(): void {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;                                   // navigateur sans audio : on ne joue rien
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume();  // reprise après une mise en veille ou un blocage
  } catch { /* pas de son : sans importance */ }
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', prime, { passive: true });
  window.addEventListener('keydown', prime, { passive: true });
}

/** « Ka-ching » : un petit claquement de tiroir-caisse puis deux notes de clochette (mi, puis mi une octave au-dessus). Dure environ 0,6 s. */
export function cashBeep(): void {
  try {
    prime();
    if (!ctx || ctx.state !== 'running') return;       // son bloqué (pas encore de toucher) : tant pis
    const c = ctx, t = c.currentTime;
    const master = c.createGain(); master.gain.value = 0.28; master.connect(c.destination);   // volume modéré
    // 1) claquement : 25 ms de bruit filtré
    const len = Math.floor(c.sampleRate * 0.025), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);   // bruit qui s'éteint
    const click = c.createBufferSource(); click.buffer = buf;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 0.8;
    click.connect(bp); bp.connect(master); click.start(t);
    // 2) deux notes de clochette : harmonique 1 et 2,76 (timbre métallique), qui s'éteignent
    const bell = (f: number, at: number, dur: number) => {
      for (const [mul, vol] of [[1, 1], [2.76, 0.35]] as const) {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = f * mul;
        g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(vol, t + at + 0.005);   // attaque très courte
        g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);                                         // extinction progressive
        o.connect(g); g.connect(master); o.start(t + at); o.stop(t + at + dur + 0.02);
      }
    };
    bell(1318.5, 0.06, 0.18);    // « ka »
    bell(2637, 0.16, 0.5);       // « ching »
  } catch { /* pas de son : sans importance */ }
}
