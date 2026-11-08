import type { ViewFactory } from '../router';
import { supabase } from '../supabase';
import { esc } from '../logic';
import type { AppLog } from '../types';

const MAX = 1000, POLL_MS = 10_000;
const DAY = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
const HMS = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour12: false });

/** Journal d'activité (administrateurs) : fenêtre façon terminal, en direct, avec suppression de lignes. */
export const logView: ViewFactory = () => ({
  mount(root) {
    let lines: AppLog[] = [];
    const picked = new Set<number>();
    let filter = '', follow = true, live = false, error = '';

    root.innerHTML = `<div class="page"><a href="#/more" class="sub">‹ Plus</a>
      <div class="row"><h1 class="grow">Journal</h1><span id="live" class="sub"></span></div>
      <div class="row wrap">
        <input id="lq" type="search" placeholder="Filtrer (nom, #n°, type…)" autocomplete="off" class="grow">
        <button class="chip" id="follow" aria-pressed="true">Suivre</button></div>
      <div class="row wrap">
        <button class="btn small" data-act="all">Sélectionner tout</button>
        <button class="btn small" data-act="none">Désélectionner</button>
        <button class="btn small danger" data-act="del" disabled>Supprimer</button></div>
      <div id="term" class="term" role="log" aria-live="polite"></div>
      <div class="sub">Touche une ligne pour la sélectionner. Les lignes supprimées laissent une trace « JOURNAL ».</div></div>`;
    const term = root.querySelector<HTMLElement>('#term')!;
    const delBtn = root.querySelector<HTMLButtonElement>('[data-act="del"]')!;

    const visible = () => {
      const q = filter.trim().toLowerCase();
      return q ? lines.filter((l) => `${l.actor_label ?? ''} ${l.kind} ${l.message}`.toLowerCase().includes(q)) : lines;
    };
    function paint() {
      const rows = visible();
      const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
      term.innerHTML = error ? `<div class="ln err">${esc(error)}</div>` : rows.length
        ? rows.map((l) => `<div class="ln${picked.has(l.id) ? ' sel' : ''}" data-id="${l.id}"><span class="ts">${DAY(l.at)} ${HMS(l.at)}</span> <span class="who">${esc(l.actor_label ?? '—')}</span> <span class="k k-${esc(l.kind)}">${esc(l.kind)}</span> ${esc(l.message)}</div>`).join('')
        : '<div class="ln dim">Aucune ligne.</div>';
      if (follow || atBottom) term.scrollTop = term.scrollHeight;
      delBtn.disabled = picked.size === 0; delBtn.textContent = picked.size ? `Supprimer (${picked.size})` : 'Supprimer';
      root.querySelector('#live')!.innerHTML = live ? '<span class="dot on"></span> temps réel' : '<span class="dot"></span> actualisé toutes les 10 s';
    }
    async function load() {
      const { data, error: e } = await supabase.from('app_log').select('id,at,actor_label,kind,message').order('id', { ascending: false }).limit(MAX);
      if (e) { error = 'Journal indisponible : ' + e.message + ' (le schema.sql à jour a-t-il été exécuté dans Supabase ?)'; }
      else { error = ''; lines = (data as AppLog[]).reverse(); for (const id of [...picked]) if (!lines.some((l) => l.id === id)) picked.delete(id); }
      paint();
    }

    term.addEventListener('click', (e) => {
      const ln = (e.target as HTMLElement).closest<HTMLElement>('.ln[data-id]'); if (!ln) return;
      const id = Number(ln.dataset.id); picked.has(id) ? picked.delete(id) : picked.add(id); follow = false; setFollow(); paint();
    });
    root.querySelector<HTMLInputElement>('#lq')!.addEventListener('input', (e) => { filter = (e.target as HTMLInputElement).value; paint(); });
    const followBtn = root.querySelector<HTMLElement>('#follow')!;
    const setFollow = () => followBtn.setAttribute('aria-pressed', String(follow));
    followBtn.addEventListener('click', () => { follow = !follow; setFollow(); paint(); });
    root.addEventListener('click', async (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'all') { for (const l of visible()) picked.add(l.id); follow = false; setFollow(); paint(); }
      if (act === 'none') { picked.clear(); paint(); }
      if (act === 'del' && picked.size) {
        if (!window.confirm(`Supprimer ${picked.size} ligne(s) du journal ? Une ligne « JOURNAL » gardera la trace de cette suppression.`)) return;
        const { error: e2 } = await supabase.rpc('delete_log_lines', { p_ids: [...picked] });
        if (e2) { window.alert('Suppression impossible : ' + e2.message); return; }
        picked.clear(); await load();
      }
    });

    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const channel = supabase.channel('app_log_live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'app_log' }, (p) => {
        const row = p.new as AppLog; if (!lines.some((l) => l.id === row.id)) { lines.push(row); if (lines.length > MAX) lines.shift(); paint(); }
      })
      .subscribe((status) => { live = status === 'SUBSCRIBED'; paint(); });
    return () => { window.clearInterval(timer); void supabase.removeChannel(channel); };
  }
});
