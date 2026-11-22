import { esc } from '../logic';

/** Livre le PDF : téléchargement direct sur ordinateur ; sur téléphone, fenêtre avec partage / téléchargement / ouverture (les téléchargements programmés y sont bloqués). */
export async function deliverPdf(blob: Blob, filename: string, title = 'PDF prêt'): Promise<void> {
  const url = URL.createObjectURL(blob);
  const file = new File([blob], filename, { type: 'application/pdf' });
  const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (!touch && !canShare) {
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000); return;
  }
  const dlg = document.createElement('dialog'); dlg.className = 'dlg';
  dlg.innerHTML = `<form method="dialog" class="stack"><h2>${esc(title)}</h2><div class="sub">${esc(filename)} · ${Math.max(1, Math.round(blob.size / 1024))} Ko</div>
    ${canShare ? '<button type="button" class="btn primary" data-a="share">Partager / enregistrer</button>' : ''}
    <a class="btn${canShare ? '' : ' primary'}" href="${url}" download="${esc(filename)}">Télécharger</a>
    <a class="btn" href="${url}" target="_blank" rel="noopener">Ouvrir</a>
    <div class="sub warn" id="shErr" role="alert"></div>
    <button class="btn" value="cancel">Fermer</button></form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('click', async (e) => {
    if (!(e.target as HTMLElement).closest('[data-a="share"]')) return;
    try { await navigator.share({ files: [file], title: filename }); } catch (er) {
      if ((er as DOMException).name !== 'AbortError') dlg.querySelector('#shErr')!.textContent = 'Partage impossible : utilise « Télécharger » ou « Ouvrir ».';
    }
  });
  dlg.addEventListener('close', () => { dlg.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); });
  dlg.showModal();
}

