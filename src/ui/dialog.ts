import { esc } from '../logic';

export interface Field {
  name: string; label: string; type?: 'text' | 'date' | 'textarea' | 'select' | 'swatch' | 'number';
  required?: boolean; search?: boolean; value?: string; min?: string; max?: string; hint?: string; options?: [string, string][];
}

/** Petite fenêtre de saisie. Renvoie les valeurs saisies, ou null si on annule. `validate` renvoie un message d'erreur ou null. */
export function openForm(title: string, fields: Field[], opts: { submit?: string; validate?: (v: Record<string, string>) => string | null } = {}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog'); dlg.className = 'dlg';
    const input = (f: Field) => f.type === 'swatch'
      ? `<span class="swatches" role="radiogroup">${(f.options ?? []).map(([v, l]) => `<label class="swatch" title="${esc(l)}"><input type="radio" name="${f.name}" value="${esc(v)}" ${v === f.value ? 'checked' : ''}><i style="background:${esc(v)}"></i><span class="sr">${esc(l)}</span></label>`).join('')}</span>`
      : f.type === 'number' ? `<span class="stepper"><button type="button" class="btn" data-step="-1" aria-label="Moins">−</button><input name="${f.name}" inputmode="numeric" pattern="[0-9]*" value="${esc(f.value ?? '')}" ${f.required ? 'required' : ''} autocomplete="off"><button type="button" class="btn" data-step="1" aria-label="Plus">+</button></span>`
      : f.type === 'textarea' ? `<textarea name="${f.name}" ${f.required ? 'required' : ''}>${esc(f.value ?? '')}</textarea>`
      : f.type === 'select' ? `${f.search ? `<input type="search" class="selsearch" data-search="${f.name}" placeholder="Taper pour filtrer…" autocomplete="off" aria-label="Filtrer">` : ''}<select name="${f.name}">${(f.options ?? []).map(([v, l]) => `<option value="${esc(v)}" ${v === f.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
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
    dlg.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((b) => b.addEventListener('click', () => {
      const inp = b.parentElement!.querySelector('input')!; const f = fields.find((x) => x.name === inp.name);
      const lo = Number(f?.min ?? 0), hi = Number(f?.max ?? 9999), cur = parseInt(inp.value, 10);
      inp.value = String(Math.min(hi, Math.max(lo, (Number.isFinite(cur) ? cur : lo) + Number(b.dataset.step))));
    }));
    dlg.querySelectorAll<HTMLInputElement>('[data-search]').forEach((inp) => {
      const sel = dlg.querySelector<HTMLSelectElement>(`select[name="${inp.dataset.search}"]`)!;
      const all = [...sel.options].map((o) => ({ v: o.value, l: o.textContent ?? '' }));
      const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      inp.addEventListener('input', () => {
        const toks = norm(inp.value).split(/\s+/).filter(Boolean), keep = sel.value;
        const shown = all.filter((o) => toks.every((t) => norm(o.l).includes(t)));
        sel.replaceChildren(...shown.map((o) => { const e = document.createElement('option'); e.value = o.v; e.textContent = o.l; e.selected = o.v === keep; return e; }));
        if (!shown.some((o) => o.v === keep) && shown.length) sel.value = shown[0].v;
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); form.requestSubmit(dlg.querySelector<HTMLButtonElement>('button[value="ok"]')); } });
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    dlg.showModal();
    dlg.querySelector<HTMLElement>('input, textarea, select')?.focus();   // un champ de filtre passe en premier
  });
}
