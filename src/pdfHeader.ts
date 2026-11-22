// Référence à l'application en haut de chaque page des PDF : nom + adresse cliquable.
export const APP_URL = 'https://stock-bdn.thierry-morin.com/';
const APP_LABEL = 'Stock BdN - stock-bdn.thierry-morin.com';

/** Écrit la référence (cliquable) en haut à droite de la page courante du document jsPDF. */
// deno-lint-ignore no-explicit-any
export function appReference(doc: any, pageW: number, margin: number): void {
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(29, 107, 255);   // petit texte bleu, comme un lien
  const x = pageW - margin - doc.getTextWidth(APP_LABEL);                                    // aligné à droite sur la marge
  doc.textWithLink(APP_LABEL, x, 9, { url: APP_URL });                                       // 9 mm du haut : dans la marge, au-dessus du contenu
  doc.setTextColor(0);                                                                       // on rend la couleur noire par défaut
}
