/** Famille de couleur (une de GEL_COLORS) la plus proche d'une référence de gel tapée à la main.
 *  L201 / LEE 201 / 201 = Lee ; R80 / Rosco 80 / #80 = Roscolux. Inconnu → « Autre ». */
const inR = (n: number, ...r: [number, number][]) => r.some(([a, b]) => n >= a && n <= b);

function lee(n: number): string {
  if (inR(n, [200, 208], [212, 215], [218, 218], [226, 226], [230, 238], [241, 249])) return 'Correction (CTO/CTB)';
  if (inR(n, [209, 211], [298, 299], [400, 400])) return 'Neutre (ND)';
  if (inR(n, [216, 217], [228, 229], [250, 297])) return 'Diffusion';
  if (inR(n, [129, 130], [219, 220])) return n === 129 ? 'Diffusion' : 'Vert';
  if ([2, 35, 36, 46, 48, 107, 108, 110, 111, 113, 127, 128, 148, 154, 157, 192, 194, 153, 109, 112, 184, 185, 186, 187, 188, 189, 190, 191].includes(n)) return 'Rose';
  if ([3, 49, 52, 53, 58, 126, 136, 137, 142, 169, 170, 180].includes(n)) return 'Violet';
  if ([19, 23, 25, 105, 147, 158, 179].includes(n)) return 'Orange';
  if ([8, 9, 16, 17, 18, 20, 21, 22, 102, 104, 134, 135, 151, 152, 162, 176].includes(n)) return 'Ambre';
  if (inR(n, [24, 29], [106, 106], [164, 166], [182, 182])) return 'Rouge';
  if (inR(n, [7, 15], [100, 101], [103, 103], [159, 159])) return 'Jaune';
  if (inR(n, [88, 90], [121, 124], [138, 139])) return 'Vert';
  if (inR(n, [61, 85], [115, 120], [131, 132], [140, 141], [143, 144], [161, 161], [165, 165], [171, 174], [181, 181], [183, 183], [195, 199])) return 'Bleu';
  return 'Autre';
}

function rosco(n: number): string {
  if (inR(n, [3200, 3299], [3400, 3499])) return 'Correction (CTO/CTB)';
  if (inR(n, [100, 139])) return 'Diffusion';
  if (inR(n, [96, 98], [298, 299], [397, 398])) return 'Neutre (ND)';
  if (inR(n, [1, 4], [9, 9], [16, 22])) return 'Ambre';
  if (inR(n, [5, 5], [30, 46])) return 'Rose';
  if (inR(n, [6, 8], [10, 15])) return 'Jaune';
  if (inR(n, [23, 23], [25, 25])) return 'Orange';
  if (inR(n, [24, 24], [26, 27])) return 'Rouge';
  if (inR(n, [47, 59])) return 'Violet';
  if (inR(n, [60, 85])) return 'Bleu';
  if (inR(n, [86, 95])) return 'Vert';
  return 'Autre';
}

export function gelColorOf(ref: string): string {
  const s = ref.trim().toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^(lee|l|rosco|roscolux|rosc|r|#)?(\d{1,4})/);
  if (!m) return 'Autre';
  const n = Number(m[2]);
  return /^(r|ro|#)/.test(m[1] ?? '') || m[1] === 'rosco' || m[1] === 'roscolux' || m[1] === 'rosc' ? rosco(n) : lee(n);
}
