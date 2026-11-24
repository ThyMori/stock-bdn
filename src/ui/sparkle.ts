// Petite explosion d'étincelles (≈ 1 s) autour d'un bouton. Coupée si l'appareil réduit les animations, interrompue par un toucher.
export function sparkle(anchor: HTMLElement, ms = 900): Promise<void> {
  // appareil qui réduit les animations : rien à afficher
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof anchor.animate !== 'function') return Promise.resolve();
  const r = anchor.getBoundingClientRect();                       // position du bouton à l'écran
  const layer = document.createElement('div'); layer.className = 'sparkle-layer'; layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);
  const anims: Animation[] = [];
  const N = 22;
  for (let k = 0; k < N; k++) {
    const p = document.createElement('span'); p.className = 'sparkle-dot';
    p.style.left = `${r.left + r.width / 2}px`; p.style.top = `${r.top + r.height / 2}px`;   // départ au centre du bouton
    layer.appendChild(p);
    const ang = (k / N) * Math.PI * 2 + Math.random() * 0.4, dist = 40 + Math.random() * 90;   // direction et portée au hasard
    anims.push(p.animate([
      { transform: 'translate(-50%,-50%) scale(.2)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist}px)) scale(1)`, opacity: 1, offset: 0.6 },
      { transform: `translate(calc(-50% + ${Math.cos(ang) * dist * 1.2}px), calc(-50% + ${Math.sin(ang) * dist * 1.2 + 18}px)) scale(.1)`, opacity: 0 }
    ], { duration: ms, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' }));
  }
  return new Promise((resolve) => {
    let done = false;
    const end = () => { if (done) return; done = true; window.removeEventListener('pointerdown', end, true); anims.forEach((a) => a.cancel()); layer.remove(); resolve(); };
    window.addEventListener('pointerdown', end, true);            // un toucher interrompt l'animation
    window.setTimeout(end, ms + 50);                               // sinon fin naturelle
  });
}
