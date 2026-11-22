// Police manuscrite des PDF « feuille de cahier » (Caveat, licence libre SIL OFL, fichiers dans src/assets/fonts).
// Elle est téléchargée seulement au moment de générer le PDF. Si le téléchargement échoue (hors ligne), le PDF se fait avec la police normale.
import regularUrl from './assets/fonts/Caveat-Regular.ttf?url';
import boldUrl from './assets/fonts/Caveat-Bold.ttf?url';

export const HAND = 'Caveat';                                  // nom de la famille dans le PDF
const cache = new Map<string, string>();                      // fichiers déjà téléchargés (base64), pour ne pas les redemander

/** Convertit un fichier en base64 par morceaux (évite de saturer la pile avec un gros fichier). */
async function toBase64(url: string): Promise<string> {
  const hit = cache.get(url); if (hit) return hit;
  const res = await fetch(url); if (!res.ok) throw new Error('police introuvable');
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const b64 = btoa(bin); cache.set(url, b64); return b64;
}

/** Ajoute la police manuscrite (normal + gras) au document jsPDF. Renvoie false si elle n'a pas pu être chargée. */
// deno-lint-ignore no-explicit-any
export async function addHandFont(doc: any): Promise<boolean> {
  try {
    const [r, b] = await Promise.all([toBase64(regularUrl), toBase64(boldUrl)]);
    doc.addFileToVFS('Caveat-Regular.ttf', r); doc.addFont('Caveat-Regular.ttf', HAND, 'normal');
    doc.addFileToVFS('Caveat-Bold.ttf', b); doc.addFont('Caveat-Bold.ttf', HAND, 'bold');
    return true;
  } catch { return false; }
}
