import type { ViewFactory } from '../router';
import { go } from '../router';
import { can, reportFault, resolveFault, setStatus, view, pull, state } from '../store';
import { esc, fmtDate, fmtDateTime } from '../logic';
import { describe } from '../ref';
import { STATUS_LABEL, STATUSES } from '../types';
import type { ItemEvent } from '../types';
import { supabase } from '../supabase';

export const itemView: ViewFactory = ([idStr]) => {
  const id = Number(idStr);
  return {
    mount(root) {
      root.innerHTML = `<div class="page">
        <div class="row"><a href="#/" class="sub">‹ Parc</a></div>
        <div id="dyn" class="stack"></div>
        <details class="card" id="faultForm"><summary>Signaler une panne</summary>
          <form class="stack" style="margin-top:12px">
            <textarea name="d" placeholder="Que se passe-t-il ? (ex. condenseur explosé, presse-étoupe…)"></textarea>
            <button class="btn primary">Envoyer le signalement</button>
          </form></details>
        <div id="adm"></div>
        <div id="hist" class="card"><h3>Historique</h3><div class="sub" style="margin-top:6px">Chargement…</div></div>
      </div>`;
      paint(root);
      renderAdmin(root);

      root.querySelector('#faultForm form')!.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target as HTMLFormElement;
        const d = (form.elements.namedItem('d') as HTMLTextAreaElement).value;
        await reportFault(id, d);
        form.reset();
        (root.querySelector('#faultForm') as HTMLDetailsElement).open = false;
      });
      root.addEventListener('click', async (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!el) return;
        if (el.dataset.act === 'status') void setStatus(id, el.dataset.v as never);
        if (el.dataset.act === 'resolve') {
          const r = window.prompt('Résolution (facultatif)', '');
          if (r !== null) void resolveFault(el.dataset.v!, r);
        }
      });
      void loadHistory(root, id);
    },
    update: (root) => paint(root)
  };

  function paint(root: HTMLElement) {
    const data = view();
    const item = data.items.find((i) => i.id === id);
    const dyn = root.querySelector('#dyn')!;
    if (!item) { dyn.innerHTML = `<div class="card empty">Projecteur n° ${id} introuvable.<br><a href="#/scan">Scanner un autre QR</a></div>`; return; }
    const d = describe(data, item);
    const faults = data.faults.filter((f) => f.item_id === id);
    const open = faults.filter((f) => !f.resolved_at), closed = faults.filter((f) => f.resolved_at);
    const tech = can('technicien');
    dyn.innerHTML = `
      <div class="card stack">
        <div class="row"><div class="big">${id}</div>
          <div class="grow"><h1>${esc(d.model?.name)}</h1><div class="sub">${esc([d.type?.name, d.family?.name].filter(Boolean).join(' · '))}</div></div></div>
        <div class="seg">${STATUSES.map((s) => `<button class="${s}" data-act="status" data-v="${s}" aria-pressed="${item.status === s}" ${tech ? '' : 'disabled'}>${STATUS_LABEL[s]}</button>`).join('')}</div>
        ${item.pending ? '<div class="sub warn">⏳ Changement enregistré sur cet appareil, en attente de synchronisation.</div>' : ''}
        ${tech ? '' : '<div class="sub">Seuls les techniciens peuvent changer l\'état.</div>'}
        <dl class="kv">
          <dt>Lampe</dt><dd>${d.lamp ? esc(d.lamp.name) + (d.lamp.power_w ? ` · ${d.lamp.power_w} W` : '') : '—'}</dd>
          <dt>Douille</dt><dd>${esc(d.socket?.name ?? '—')}</dd>
          <dt>Porte-filtre</dt><dd>${d.filter ? `${esc(d.filter.label)} <span class="muted">(${d.filter.sheets_lee ?? '–'} / feuille LEE · ${d.filter.sheets_rosco ?? '–'} / feuille Rosco)</span>` : '—'}</dd>
          <dt>Dernier SAV</dt><dd>${fmtDate(item.last_service)}</dd>
          <dt>Notice</dt><dd>${d.model?.notice_url ? `<a href="${esc(d.model.notice_url)}" target="_blank" rel="noopener">Ouvrir la fiche technique</a>` : '—'}</dd>
        </dl>
      </div>
      <div class="card stack"><h2>Pannes ${open.length ? `<span class="warn">(${open.length} en cours)</span>` : ''}</h2>
        ${open.map((x) => `<div class="row"><div class="grow"><div>${esc(x.description || 'Sans description')}${x.pending ? ' ⏳' : ''}</div>
            <div class="sub">${esc(x.reported_by_label ?? 'moi')} · ${fmtDateTime(x.reported_at)}</div></div>
            ${tech ? `<button class="btn small" data-act="resolve" data-v="${x.id}">Résolue</button>` : ''}</div>`).join('') || '<div class="sub">Aucune panne en cours.</div>'}
        ${closed.length ? `<h3 class="muted">Résolues</h3>` + closed.map((x) => `<div class="sub">✓ ${esc(x.description || 'Sans description')}${x.resolution ? ' → ' + esc(x.resolution) : ''} (${fmtDate(x.resolved_at)})</div>`).join('') : ''}
      </div>`;
  }

  function renderAdmin(root: HTMLElement) {
    if (!can('admin')) return;
    const data = view();
    const item = data.items.find((i) => i.id === id);
    if (!item) return;
    root.querySelector('#adm')!.innerHTML = `<details class="card"><summary>Modifier (administrateur)</summary>
      <form class="stack" style="margin-top:12px">
        <label class="f">Modèle<select name="m">${data.models.map((m) => `<option value="${m.id}" ${m.id === item.model_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
        <label class="f">Lampe<select name="l"><option value="">—</option>${data.lamps.map((l) => `<option value="${l.id}" ${l.id === item.lamp_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
        <div class="row"><button class="btn primary grow">Enregistrer</button><button type="button" class="btn danger" id="del">Supprimer</button></div>
        <div class="sub" id="admMsg"></div></form></details>`;
    const msg = root.querySelector('#admMsg')!;
    root.querySelector('#adm form')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target as HTMLFormElement);
      const { error } = await supabase.from('items').update({ model_id: fd.get('m'), lamp_id: fd.get('l') || null, updated_at: new Date().toISOString() }).eq('id', id);
      msg.textContent = error ? 'Erreur : ' + error.message : 'Enregistré.';
      if (!error) { await pull(); paint(root); }
    });
    root.querySelector('#del')!.addEventListener('click', async () => {
      if (!window.confirm(`Supprimer définitivement le projecteur n° ${id} et son historique ?`)) return;
      const { error } = await supabase.from('items').delete().eq('id', id);
      if (error) { msg.textContent = 'Erreur : ' + error.message; return; }
      await pull(); go('#/');
    });
  }
};

async function loadHistory(root: HTMLElement, id: number) {
  const box = root.querySelector('#hist')!;
  if (!navigator.onLine || !state.session) { box.innerHTML = '<h3>Historique</h3><div class="sub" style="margin-top:6px">Disponible en ligne uniquement.</div>'; return; }
  const { data, error } = await supabase.from('item_events').select('*').eq('item_id', id).order('at', { ascending: false }).limit(30);
  if (error) { box.innerHTML = '<h3>Historique</h3><div class="sub" style="margin-top:6px">Indisponible.</div>'; return; }
  const ev = (data ?? []) as ItemEvent[];
  const text = (e: ItemEvent) => e.kind === 'status' ? `État → ${STATUS_LABEL[e.status!]}` : e.kind === 'fault' ? `Panne signalée${e.note ? ' : ' + e.note : ''}` : `Panne résolue${e.note ? ' : ' + e.note : ''}`;
  box.innerHTML = `<h3>Historique</h3>` + (ev.length
    ? `<div class="stack" style="margin-top:8px">${ev.map((e) => `<div class="sub"><span class="muted">${fmtDateTime(e.at)}</span> · ${esc(text(e))} <span class="muted">— ${esc(e.created_by_label ?? '')}</span></div>`).join('')}</div>`
    : '<div class="sub" style="margin-top:6px">Aucun événement enregistré depuis la migration.</div>');
}
