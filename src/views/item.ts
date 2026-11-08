import type { ViewFactory } from '../router';
import { go } from '../router';
import { can, canActShow, immoCall, rpcCall, setLamp, reportFault, resolveFault, setStatus, view, pull, state } from '../store';
import { currentImmo, esc, fmtDate, fmtDateTime, immoState, dayNum, todayStr, uuid } from '../logic';
import { agendaHtml, fmtDay } from './agenda';
import { openForm } from '../ui/dialog';
import { describe, isPar, parLamps } from '../ref';
import { mentionedItems, personColor, renderBody } from '../wall';
import { STATUS_LABEL, STATUSES, showColor } from '../types';
import type { ItemEvent } from '../types';
import { supabase } from '../supabase';

export const itemView: ViewFactory = ([idStr]) => {
  const id = Number(idStr);
  let offset = 0;                       // décalage de la frise de l'agenda, en mois
  return {
    mount(root) {
      root.innerHTML = `<div class="page">
        <div class="row"><a href="#/" class="sub">‹ Parc</a></div>
        <div id="dyn" class="stack"></div>
        <div id="agenda" class="card stack"></div>
        <div id="shows" class="card stack"></div>
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
        const act = el.dataset.act;
        if (act === 'status') void changeStatus(el.dataset.v as 'dispo' | 'sav' | 'en_pret');
        if (act === 'agenda-nav') { offset = el.dataset.v === '0' ? 0 : offset + Number(el.dataset.v); paintAgenda(root); }
        if (act === 'lamp') setLamp(id, el.dataset.v!);
        if (act === 'show-assign') void assignToShow(root);
        if (act === 'show-remove') { const sid = el.dataset.v!; if (window.confirm('Retirer ce projecteur du spectacle ?')) void rpcCall('unassign_items', { p_show: sid, p_items: [id] }); }
        if (act === 'immo-add') void immoForm(root);
        if (act === 'immo-edit') void immoForm(root, el.dataset.v);
        if (act === 'immo-del') void immoDelete(root, el.dataset.v!);
        if (el.dataset.act === 'resolve') {
          const r = window.prompt('Résolution (facultatif)', '');
          if (r !== null) void resolveFault(el.dataset.v!, r);
        }
      });
      void loadHistory(root, id);
    },
    update: (root) => paint(root)
  };

  async function changeStatus(s: 'dispo' | 'sav' | 'en_pret') {
    const item = view().items.find((i) => i.id === id);
    if (!item || item.status === s) return;
    const today = todayStr();
    const dates = (v: Record<string, string>) => (v.from && v.from > today ? 'La date de début ne peut pas être dans le futur (utilise « Planifier » dans l\'agenda).'
      : v.until && v.from && v.until < v.from ? 'La date de fin précède la date de début.' : null);
    if (s === 'en_pret') {
      const v = await openForm(`Prêter le n° ${id}`, [
        { name: 'who', label: 'À qui ?', required: true, hint: 'Personne, compagnie, théâtre…' },
        { name: 'from', label: 'Date du prêt', type: 'date', required: true, value: today, max: today },
        { name: 'until', label: 'Retour prévu', type: 'date', min: today },
        { name: 'note', label: 'Remarque' }], { submit: 'Valider le prêt', validate: dates });
      if (v) void setStatus(id, s, { who: v.who, from: v.from, until: v.until, note: v.note });
    } else if (s === 'sav') {
      const v = await openForm(`Passer le n° ${id} en SAV`, [
        { name: 'note', label: 'Motif' },
        { name: 'from', label: 'Début du SAV', type: 'date', required: true, value: today, max: today },
        { name: 'until', label: 'Fin prévue', type: 'date', min: today, hint: 'Laisse vide si la date de retour n\'est pas connue.' }], { submit: 'Passer en SAV', validate: dates });
      if (v) void setStatus(id, s, { note: v.note, from: v.from, until: v.until });
    } else {
      void setStatus(id, s);
    }
  }

  async function immoDelete(root: HTMLElement, immoId: string) {
    const m = view().immos.find((x) => x.id === immoId);
    if (!m) return;
    const running = !m.closed_date && m.start_date <= todayStr();
    const what = `${m.kind === 'pret' ? 'prêt' : 'SAV'}${m.who ? ' (' + m.who + ')' : ''} du ${fmtDay(m.start_date)}`;
    if (!window.confirm(`Supprimer cette période : ${what} ?${running ? '\n\nElle est en cours : le projecteur redeviendra « Disponible ».' : ''}`)) return;
    const err = await immoCall('delete_immo', { p_id: immoId });
    if (err) window.alert('Impossible : ' + err);
    paint(root);
  }

  async function immoForm(root: HTMLElement, immoId?: string) {
    const cur = immoId ? view().immos.find((m) => m.id === immoId) : undefined;
    const today = todayStr();
    const v = await openForm(cur ? 'Modifier la période' : 'Ajouter / planifier une période', [
      ...(cur ? [] : [{ name: 'kind', label: 'Type', type: 'select' as const, value: 'pret', options: [['pret', 'Prêt'], ['sav', 'SAV']] as [string, string][] }]),
      { name: 'who', label: 'À qui (prêt)', value: cur?.who ?? '' },
      { name: 'note', label: 'Remarque / motif', value: cur?.note ?? '' },
      { name: 'start', label: 'Début', type: 'date', required: true, value: cur?.start_date ?? today },
      { name: 'end', label: 'Fin prévue', type: 'date', value: cur?.end_date ?? '' },
      { name: 'closed', label: 'Fin réelle (retour / réparation terminée)', type: 'date', value: cur?.closed_date ?? '', hint: 'Pour corriger une date passée ; pour clôturer normalement, change l\'état du projecteur.' }],
      { validate: (x) => (x.end && x.end < x.start) || (x.closed && x.closed < x.start) ? 'Une date de fin précède la date de début.' : null });
    if (!v) return;
    const err = cur
      ? await immoCall('edit_immo', { p_id: cur.id, p_who: v.who || null, p_note: v.note || null, p_start: v.start, p_end: v.end || null, p_closed: v.closed || null })
      : await immoCall('add_immo', { p_id: uuid(), p_item: id, p_kind: v.kind, p_who: v.who || null, p_note: v.note || null, p_start: v.start, p_end: v.end || null, p_closed: v.closed || null });
    if (err) window.alert('Impossible : ' + err);
    paint(root);
  }

  function paintShows(root: HTMLElement) {
    const data = view(); const el = root.querySelector('#shows'); if (!el) return;
    const mine = data.showItems.filter((x) => x.item_id === id).map((x) => ({ x, s: data.shows.find((s) => s.id === x.show_id) })).filter((r) => r.s)
      .sort((a, b) => a.s!.start_date.localeCompare(b.s!.start_date));
    el.innerHTML = `<h2>Spectacles</h2>` + (mine.length ? mine.map(({ x, s }) => {
      const lamp = data.lamps.find((l) => l.id === x.lamp_id)?.name;
      return `<div class="row"><i class="dotc" style="background:${showColor(s!)}"></i><div class="grow"><a href="#/show/${s!.id}"><b>${esc(s!.name)}</b></a><div class="sub">du ${fmtDay(s!.start_date)} au ${fmtDay(s!.end_date)}${lamp ? ' · lampe requise : ' + esc(lamp) : ''}</div></div>
        ${canActShow(s!.id) ? `<button class="btn" data-act="show-remove" data-v="${s!.id}">Retirer</button>` : ''}</div>`;
    }).join('') : `<div class="sub">Aucun spectacle</div>`) + (() => {
      const cited = data.showPosts.filter((p) => mentionedItems(p.body).includes(id)).slice(0, 5);
      return cited.length ? `<h3>Cité sur les murs</h3>` + cited.map((p) => `<a class="post" style="--pc:${personColor(p.author_id)}" href="#/show/${p.show_id}"><header><b class="who">${esc(p.author_label ?? '')}</b> <span class="muted">${esc(data.shows.find((s) => s.id === p.show_id)?.name ?? '')} · ${esc(fmtDateTime(p.created_at))}</span></header><div class="body">${renderBody(p.body)}</div></a>`).join('') : '';
    })() + (can('regisseur') ? `<button class="btn" data-act="show-assign">Assigner à un spectacle</button>` : '');
  }

  async function assignToShow(root: HTMLElement) {
    const data = view(); const today = todayStr();
    const item = data.items.find((i) => i.id === id); if (!item) return;
    const taken = new Set(data.showItems.filter((x) => x.item_id === id).map((x) => x.show_id));
    const open = data.shows.filter((s) => s.end_date >= today && !taken.has(s.id) && canActShow(s.id));
    if (!open.length) { window.alert('Aucun spectacle disponible : il faut être assigné à un spectacle à venir ou en cours.'); return; }
    const par = /^PAR/i.test(describe(data, item).type?.name ?? '');
    const lamps = data.lamps.filter((l) => /^CP\d+/i.test(l.name));
    const v = await openForm('Assigner à un spectacle', [
      { name: 'show', label: 'Spectacle', type: 'select', options: open.map((s) => [s.id, `${s.name} (${fmtDay(s.start_date)} → ${fmtDay(s.end_date)})`]), required: true },
      ...(par ? [{ name: 'lamp', label: 'Lampe requise', type: 'select' as const, required: true, options: lamps.map((l): [string, string] => [l.id, l.name]) }] : [])
    ], { submit: 'Assigner' });
    if (!v) return;
    const r = await rpcCall('assign_items', { p_show: v.show, p_items: [id], p_lamp: par ? v.lamp : null });
    const sk = (r.data as { skipped?: { reason: string }[] } | null)?.skipped ?? [];
    const msg = r.error ?? sk[0]?.reason;
    if (msg) window.alert(msg);
    void root;
  }

  function paintAgenda(root: HTMLElement) {
    const data = view();
    const el = root.querySelector('#agenda'); if (!el) return;
    el.innerHTML = agendaHtml(data.immos.filter((m) => m.item_id === id), offset, can('regisseur_general'));
  }

  function paint(root: HTMLElement) {
    const data = view();
    const item = data.items.find((i) => i.id === id);
    const dyn = root.querySelector('#dyn')!;
    if (!item) { dyn.innerHTML = `<div class="card empty">Projecteur n° ${id} introuvable.<br><a href="#/scan">Scanner un autre QR</a></div>`; return; }
    paintAgenda(root);
    paintShows(root);
    const d = describe(data, item);
    const faults = data.faults.filter((f) => f.item_id === id);
    const open = faults.filter((f) => !f.resolved_at), closed = faults.filter((f) => f.resolved_at);
    const canStatus = can('regisseur_general'), canResolve = can('regisseur');
    const today = todayStr();
    const cur = currentImmo(data.immos, id, today);
    const curInfo = cur ? (() => {
      const st = immoState(cur, today);
      const late = st === 'late' ? ` <span class="tag late">retour en retard de ${dayNum(today) - dayNum(cur.end_date!)} j</span>` : '';
      return cur.kind === 'pret'
        ? `<div class="sub"><b>Prêté</b>${cur.who ? ' à <b>' + esc(cur.who) + '</b>' : ''} depuis le ${fmtDay(cur.start_date)}${cur.end_date ? ' · retour prévu le ' + fmtDay(cur.end_date) : ''}${late}</div>`
        : `<div class="sub"><b>En SAV</b> depuis le ${fmtDay(cur.start_date)}${cur.end_date ? ' · fin prévue le ' + fmtDay(cur.end_date) : ''}${cur.note ? ' · ' + esc(cur.note) : ''}${late}</div>`;
    })() : '';
    dyn.innerHTML = `
      <div class="card stack">
        <div class="row"><div class="big">${id}</div>
          <div class="grow"><h1>${esc(d.model?.name)}</h1><div class="sub">${esc([d.type?.name, d.family?.name].filter(Boolean).join(' · '))}</div></div></div>
        <div class="seg">${STATUSES.map((s) => `<button class="${s}" data-act="status" data-v="${s}" aria-pressed="${item.status === s}" ${canStatus ? '' : 'disabled'}>${STATUS_LABEL[s]}</button>`).join('')}</div>
        ${curInfo}
        ${item.pending ? '<div><span class="pending">En attente de synchronisation</span></div>' : ''}
        ${canStatus ? '' : '<div class="sub">Seuls les régisseurs généraux et les administrateurs peuvent changer l\'état.</div>'}
        ${isPar(data, item) && can('technicien') ? `<div class="lampquick"><div class="sub">Lampe du PAR</div><div class="seg" role="group" aria-label="Changer la lampe">${parLamps(data).map((l) => `<button data-act="lamp" data-v="${esc(l.id)}" aria-pressed="${item.lamp_id === l.id}">${esc(l.name)}</button>`).join('')}</div></div>` : ''}
        <dl class="kv">
          <dt>Lampe</dt><dd>${d.lamp ? esc(d.lamp.name) + (d.lamp.power_w ? ` · ${d.lamp.power_w} W` : '') : '—'}</dd>
          <dt>Douille</dt><dd>${esc(d.socket?.name ?? '—')}</dd>
          <dt>Porte-filtre</dt><dd>${d.filter ? `${esc(d.filter.label)} <span class="muted">(${d.filter.sheets_lee ?? '–'} / feuille LEE · ${d.filter.sheets_rosco ?? '–'} / feuille Rosco)</span>` : '—'}</dd>
          <dt>Dernier SAV</dt><dd>${fmtDate(item.last_service)}</dd>
          <dt>Notice</dt><dd>${d.model?.notice_url ? `<a href="${esc(d.model.notice_url)}" target="_blank" rel="noopener">Ouvrir la fiche technique</a>` : '—'}</dd>
        </dl>
      </div>
      <div class="card stack"><h2>Pannes ${open.length ? `<span class="warn">(${open.length} en cours)</span>` : ''}</h2>
        ${open.map((x) => `<div class="row"><div class="grow"><div><a href="#/fault/${x.id}">${esc(x.description || 'Sans description')}</a>${x.pending ? ' <span class="pending">en attente</span>' : ''}</div>
            <div class="sub">${esc(x.reported_by_label ?? 'moi')} · ${fmtDateTime(x.reported_at)}</div></div>
            ${canResolve ? `<button class="btn small" data-act="resolve" data-v="${x.id}">Résolue</button>` : ''}</div>`).join('') || '<div class="sub">Aucune panne en cours.</div>'}
        ${closed.length ? `<h3 class="muted">Résolues</h3>` + closed.map((x) => `<div class="sub">✓ <a href="#/fault/${x.id}">${esc(x.description || 'Sans description')}</a>${x.resolution ? ' → ' + esc(x.resolution) : ''} (${fmtDate(x.resolved_at)}${x.resolved_by_label ? ' par ' + esc(x.resolved_by_label) : ''})</div>`).join('') : ''}
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
