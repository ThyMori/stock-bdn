import QrScanner from 'qr-scanner';
import type { ViewFactory } from '../router';
import { go } from '../router';
import { parseScan, esc } from '../logic';
import { view } from '../store';

export const scanView: ViewFactory = () => ({
  mount(root) {
    root.innerHTML = `<div class="page">
      <h1>Scanner</h1>
      <div class="viewport"><video playsinline muted></video></div>
      <div id="msg" class="sub" role="status">Démarrage de la caméra…</div>
      <form id="manual" class="row"><input name="n" inputmode="numeric" pattern="[0-9]*" placeholder="…ou saisir le n° du projecteur" autocomplete="off">
        <button class="btn primary">Ouvrir</button></form></div>`;
    const msg = root.querySelector<HTMLElement>('#msg')!;
    const video = root.querySelector('video')!;
    let done = false, last = '', lastAt = 0;

    const open = (text: string): boolean => {
      const n = parseScan(text);
      if (n === null) { msg.textContent = `QR non reconnu : « ${text.slice(0, 40)} »`; return false; }
      if (!view().items.some((i) => i.id === n)) { msg.textContent = `Projecteur n° ${n} introuvable dans la base.`; return false; }
      done = true; navigator.vibrate?.(60); go(`#/item/${n}`); return true;
    };
    const scanner = new QrScanner(video, (r) => {
      if (done || (r.data === last && Date.now() - lastAt < 2500)) return;
      last = r.data; lastAt = Date.now(); open(r.data);
    }, { returnDetailedScanResult: true, preferredCamera: 'environment', maxScansPerSecond: 8, highlightScanRegion: false });

    scanner.start().then(() => { msg.textContent = 'Place le QR code dans le cadre.'; })
      .catch((e) => { msg.innerHTML = `Caméra indisponible (${esc(String(e))}). Autorise l'accès dans les réglages du navigateur ou saisis le numéro ci-dessous.`; });

    root.querySelector('#manual')!.addEventListener('submit', (e) => {
      e.preventDefault();
      open(String(new FormData(e.target as HTMLFormElement).get('n') ?? ''));
    });
    return () => { scanner.stop(); scanner.destroy(); };
  }
});
