import { esc } from '../logic';

export interface Field {
  name: string; label: string; type?: 'text' | 'date' | 'textarea' | 'select';
  required?: boolean; value?: string; min?: string; max?: string; hint?: string; options?: [string, string][];
}

/** Petite fenêtre de saisie. Renvoie les valeurs saisies, ou null si on annule. `validate` renvoie un message d'erreur ou null. */
export function openForm(title: string, fields: Field[], opts: { submit?: string; validate?: (v: Record<string, string>) => string | null } = {}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog'); dlg.className = 'dlg';
    const input = (f: Field) => f.type === 'textarea' ? `<textarea name="${f.name}" ${f.required ? 'required' : ''}>${esc(f.value ?? '')}</textarea>`
      : f.type === 'select' ? `<select name="${f.name}">${(f.options ?? []).map(([v, l]) => `<option value="${esc(v)}" ${v === f.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
      : `<input name="${f.name}" type="${f.type ?? 'text'}" value="${esc(f.value ?? '')}" ${f.required ? 'required' : ''} ${f.min ? `min="${f.min}"` : ''} ${f.max ? `max="${f.max}"` : ''} autocomplete="off">`;
    dlg.innerHTML = `<form method="dialog" class="stack"><h2>${esc(title)}</h2>
      ${fields.map((f) => `<label class="f">${esc(f.label)}${f.required ? '' : ' <span class="muted">(facultatif)</span>'}${input(f)}${f.hint ? `<span class="muted">${esc(f.hint)}</span>` : ''}</label>`).join('')}
      <div class="sub warn" id="dlgErr"></div>
      <div class="row"><button class="btn primary grow" value="ok">${esc(opts.submit ?? 'Enregistrer')}</button><button class="btn" value="cancel" formnovalidate>Annuler</button></div></form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form')!;
    let done = false;
    const finish = (v: Record<string, string> | null) => { if (done) return; done = true; dlg.close(); dlg.remove(); resolve(v); };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const sub = (e as SubmitEvent).submitter as HTMLButtonElement | null;
      if (sub?.value === 'cancel') return finish(null);
      if (!form.reportValidity()) return;
      const v: Record<string, string> = {};
      for (const f of fields) v[f.name] = String(new FormData(form).get(f.name) ?? '').trim();
      const err = opts.validate?.(v) ?? null;
      if (err) { dlg.querySelector('#dlgErr')!.textContent = err; return; }
      finish(v);
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    dlg.showModal();
    dlg.querySelector<HTMLElement>('input, textarea, select')?.focus();
  });
}
