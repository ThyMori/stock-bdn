/** Message flottant bien visible (les erreurs affichées en haut de page passaient inaperçues). */
let timer: number | undefined;
export function toast(msg: string, kind: 'err' | 'ok' = 'err'): void {
  document.getElementById('toast')?.remove();
  if (!msg) return;
  const el = document.createElement('div');
  el.id = 'toast'; el.className = 'toast ' + kind; el.setAttribute('role', 'alert'); el.textContent = msg;
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
  window.clearTimeout(timer); timer = window.setTimeout(() => el.remove(), 8000);
}
