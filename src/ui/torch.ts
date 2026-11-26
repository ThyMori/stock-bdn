// Flash (lampe torche) du scanner : allumé par défaut à chaque lancement, avec un bouton pour le couper. Aucun accès réseau.
import type QrScanner from 'qr-scanner';

/** Démarre la caméra puis allume le flash s'il existe, et ajoute un bouton 🔦 pour le couper/rallumer.
 *  Renvoie la promesse de démarrage (les appelants gardent leur gestion d'erreur « Caméra indisponible »). */
export async function startScan(scanner: QrScanner, video: HTMLVideoElement): Promise<void> {
  await scanner.start();                                          // lance la caméra (peut échouer : l'appelant l'affiche)
  try {
    if (!(await scanner.hasFlash())) return;                      // pas de flash sur cet appareil / ce navigateur : aucun bouton
    await scanner.turnFlashOn();                                  // allumé par défaut
    const zone = video.parentElement; if (!zone || zone.querySelector('.torch-btn')) return;   // une seule fois par zone
    const b = document.createElement('button'); b.type = 'button'; b.className = 'torch-btn';
    const paint = () => { const on = scanner.isFlashOn(); b.textContent = on ? '🔦 Flash : oui' : '🔦 Flash : non'; b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Couper le flash' : 'Allumer le flash'); };
    b.addEventListener('click', async () => { try { await scanner.toggleFlash(); } catch { /* flash perdu : on ne bloque pas le scan */ } paint(); });   // bascule
    paint(); zone.appendChild(b);                                 // bouton posé dans le cadre de la caméra
  } catch { /* le flash est un confort : une erreur ici ne doit jamais empêcher de scanner */ }
}
