import QRCode from 'qrcode';
import type { ViewFactory } from '../router';
import { view } from '../store';

export const labelsView: ViewFactory = (_p, query) => ({
  mount(root) {
    const ids = view().items.map((i) => i.id);
    const from = query.get('from') ?? String(Math.min(...ids, 1));
    const to = query.get('to') ?? String(Math.max(...ids, 1));
    root.innerHTML = `<div class="page">
      <div class="noprint stack"><a href="#/more" class="sub">‹ Plus</a><h1>Étiquettes QR</h1>
        <form id="f" class="row"><label class="f grow">De<input name="from" type="number" min="0" value="${from}"></label>
          <label class="f grow">À<input name="to" type="number" min="0" value="${to}"></label>
          <button class="btn primary" style="align-self:end">Générer</button></form>
        <div class="sub">Chaque QR contient l'adresse de l'appli + le numéro : l'appareil photo du téléphone ouvre directement la fiche, et le scanner intégré lit aussi le simple numéro des anciens stickers.</div>
        <button class="btn" id="print">Imprimer</button></div>
      <div id="out" class="labels"></div></div>`;
    const out = root.querySelector('#out')!;
    const base = new URL(import.meta.env.BASE_URL, location.origin).href;
    const render = async (a: number, b: number) => {
      b = Math.min(b, a + 499);
      const parts: string[] = [];
      for (let n = a; n <= b; n++) {
        const url = await QRCode.toDataURL(`${base}#/item/${n}`, { margin: 0, width: 256, errorCorrectionLevel: 'M' });
        parts.push(`<div class="label"><img src="${url}" alt="QR ${n}"><b>${n}</b></div>`);
      }
      out.innerHTML = parts.join('');
    };
    root.querySelector('#f')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target as HTMLFormElement);
      void render(Number(fd.get('from')), Number(fd.get('to')));
    });
    root.querySelector('#print')!.addEventListener('click', () => window.print());
    void render(Number(from), Number(to));
  }
});
