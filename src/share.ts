// Partage de l'adresse de l'appli : feuille de partage du téléphone, sinon copie dans le presse-papiers.
import { APP_URL } from './pdfHeader';
import { toast } from './ui/toast';

export async function shareApp(): Promise<void> {
  const data = { title: 'Stock BdN', text: 'Stock BdN : le parc de projecteurs des Bouffes du Nord.', url: APP_URL };
  if (navigator.share) {
    try { await navigator.share(data); return; }
    catch (e) { if ((e as Error)?.name === 'AbortError') return; }   // partage annulé : rien à faire ; autre erreur : on copie
  }
  try { await navigator.clipboard.writeText(APP_URL); toast('Adresse copiée : ' + APP_URL, 'ok'); }
  catch { toast('Partage impossible ici. Adresse : ' + APP_URL); }
}
