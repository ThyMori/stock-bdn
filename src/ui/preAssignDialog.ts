// Fenêtre d'aperçu de la pré-affectation : liste ce qui sera affecté et ce qui manque, puis demande confirmation.
import type { Plan } from '../preAssign';
import type { Data } from '../types';
import { zoneLabel } from '../zones';

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
      // une ligne par zone : « Plateau : n° 1, 2 » ; les projecteurs venus d'une autre zone (ou repêchés) sont signalés
      for (const z of ['plateau', 'face', 'corbeille', ''] as const) {
        const zl = list.filter((p) => p.zone === z); if (!zl.length) continue;
        const s = document.createElement('div'); s.className = 's';
        s.textContent = `${z ? zoneLabel(z) : 'Sans zone précise'} : n° ${zl.map((p) => p.item).join(', ')}`; box.appendChild(s);
        const moved = zl.filter((p) => p.how === 'cross'), rep = zl.filter((p) => p.how === 'repeche');
        if (moved.length) { const w = document.createElement('div'); w.className = 'sub'; w.textContent = `Changent de zone : n° ${moved.map((p) => p.item).join(', ')}`; box.appendChild(w); }
        if (rep.length) { const w = document.createElement('div'); w.className = 'sub warn'; w.textContent = `Repêchés (plus de stock) : n° ${rep.map((p) => p.item).join(', ')}`; box.appendChild(w); }
      }
      const relamp = list.filter((p) => p.relamp);
      if (relamp.length) { const w = document.createElement('div'); w.className = 'sub warn'; w.textContent = `À relamper en ${lamp(head.lamp)} : n° ${relamp.map((p) => p.item).join(', ')}`; box.appendChild(w); }
      form.appendChild(box);
    }
    if (!plan.proposals.length) add('div', 'Aucun projecteur à proposer : la demande est déjà couverte, ou rien n\'est disponible.', 'empty');
    // à préparer depuis un stock (projecteurs absents du spectacle précédent) : face = 3e, plateau / corbeille / sans zone = dessous
    if (plan.prepNeeds.length) add('div', 'À préparer (feuille de prépa + scan) :', 'sub');
    for (const x of plan.prepNeeds) add('div', `${x.n} × ${model(x.modelId)}${x.lamp ? ' ' + lamp(x.lamp) : ''}${x.zone ? ' pour ' + zoneLabel(x.zone) : ''} : depuis ${x.from === 'stock3' ? 'le stock du 3e' : 'les dessous'}${x.fallback ? ' (repli : l\'autre stock est vide)' : ''}.`, x.fallback ? 'sub warn' : 'sub');
    for (const s of plan.unavailable) add('div', `Il manquera ${s.n} × ${model(s.modelId)}${s.lamp ? ' ' + lamp(s.lamp) : ''} : plus aucun disponible.`, 'sub warn');
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
