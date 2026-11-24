// Fenêtre d'aperçu de la pré-affectation : liste ce qui sera affecté et ce qui manque, puis demande confirmation.
import type { Plan } from '../preAssign';
import type { Data } from '../types';

/** Affiche l'aperçu (texte posé par textContent, jamais innerHTML). Renvoie true si on confirme. */
export function previewPlan(data: Data, plan: Plan, targetName: string, prevName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog'); dlg.className = 'dlg preview';
    const form = document.createElement('form'); form.method = 'dialog'; form.className = 'stack';
    const add = (tag: string, text: string, cls = '') => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; form.appendChild(e); return e; };
    const model = (id: string) => data.models.find((m) => m.id === id)?.name ?? '?';
    const lamp = (id: string | null) => (id ? data.lamps.find((l) => l.id === id)?.name ?? id : '');
    add('h2', '✦ Pré-affectation');
    add('div', `Depuis « ${prevName} » vers « ${targetName} ».`, 'sub');
    // regroupement par modèle + lampe
    const groups = new Map<string, typeof plan.proposals>();
    for (const p of plan.proposals) { const k = p.demandId; groups.set(k, [...(groups.get(k) ?? []), p]); }
    for (const [, list] of groups) {
      const head = list[0];
      const box = document.createElement('div'); box.className = 'pre-grp';
      const t = document.createElement('div'); t.className = 't'; t.textContent = `${list.length} × ${model(head.modelId)}${head.lamp ? ' ' + lamp(head.lamp) : ''}`; box.appendChild(t);
      const s = document.createElement('div'); s.className = 's'; s.textContent = 'n° ' + list.map((p) => p.item).join(', '); box.appendChild(s);
      const relamp = list.filter((p) => p.relamp);
      if (relamp.length) { const w = document.createElement('div'); w.className = 'sub warn'; w.textContent = `À relamper en ${lamp(head.lamp)} : n° ${relamp.map((p) => p.item).join(', ')}`; box.appendChild(w); }
      const stock = list.filter((p) => p.from === 'stock');
      if (stock.length) { const w = document.createElement('div'); w.className = 'sub'; w.textContent = `Pris en stock (non montés sur « ${prevName} ») : n° ${stock.map((p) => p.item).join(', ')}`; box.appendChild(w); }
      form.appendChild(box);
    }
    if (!plan.proposals.length) add('div', 'Aucun projecteur à proposer : la demande est déjà couverte, ou rien n\'est disponible.', 'empty');
    for (const s of plan.shortages) add('div', `Il manquera ${s.n} × ${model(s.modelId)}${s.lamp ? ' ' + lamp(s.lamp) : ''}.`, 'sub warn');
    const row = document.createElement('div'); row.className = 'row';
    const ok = document.createElement('button'); ok.className = 'btn primary grow'; ok.value = 'ok'; ok.disabled = !plan.proposals.length;
    ok.textContent = `Affecter ${plan.proposals.length} projecteur${plan.proposals.length > 1 ? 's' : ''}`;
    const no = document.createElement('button'); no.className = 'btn'; no.value = 'cancel'; no.textContent = 'Annuler'; no.setAttribute('formnovalidate', '');
    row.append(ok, no); form.appendChild(row); dlg.appendChild(form); document.body.appendChild(dlg);
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; dlg.close(); dlg.remove(); resolve(v); };
    form.addEventListener('submit', (e) => { e.preventDefault(); finish((e as SubmitEvent).submitter === ok); });
    dlg.addEventListener('cancel', () => finish(false));            // touche Échap
    dlg.showModal();
    (dlg.querySelector('h2') as HTMLElement).tabIndex = -1; (dlg.querySelector('h2') as HTMLElement).focus();   // focus sur le titre
  });
}
