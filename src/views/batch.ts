// Modification par lot (régisseurs généraux et admins) : on choisit les réglages, on scanne le lot, on applique à tous.
import QrScanner from 'qr-scanner';
import { startScan } from '../ui/torch';
import type { ViewFactory } from '../router';
import { esc, parseScan, todayStr } from '../logic';
import { emit, pull, view } from '../store';
import { supabase } from '../supabase';
import { cashBeep } from '../ui/beep';
import { confirmBox } from '../ui/dialog';
import { toast } from '../ui/toast';
import { friendlyError, isNetworkMessage } from '../netError';
import { inUpcomingShows, planItem, summarize, validateChanges } from '../batchEdit';
import type { BatchChanges, BatchStep } from '../batchEdit';

export const batchView: ViewFactory = () => ({
  mount(root) {
    const lamps = view().lamps.filter((l) => /^CP\d+/i.test(l.name));   // mêmes lampes que le changement rapide à l'unité
    const lot: number[] = [];
    root.innerHTML = `<div class="page stack"><a href="#/more" class="sub">‹ Plus</a><h1>Modification par lot</h1>
      <div class="sub">1. Coche ce que tu veux modifier · 2. scanne tout le lot · 3. applique à tous.</div>
      <div class="card stack"><h2>1. Ce que je modifie</h2>
        <label class="batch-row"><input type="checkbox" id="c-blue"> <b>Pastille bleue</b></label>
        <select id="v-blue" aria-label="Pastille bleue" disabled><option value="1">Ajouter (stocké au 3e)</option><option value="0">Retirer</option></select>
        <label class="batch-row"><input type="checkbox" id="c-lamp"> <b>Lampe</b> <span class="sub">(PAR seulement)</span></label>
        <select id="v-lamp" aria-label="Lampe" disabled>${lamps.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select>
        <label class="batch-row"><input type="checkbox" id="c-st"> <b>État</b></label>
        <select id="v-st" aria-label="État" disabled><option value="dispo">Disponible</option><option value="sav">SAV (maintenance, sans panne)</option><option value="en_pret">Prêt</option></select>
        <label class="f" id="f-note" hidden><span id="l-note">Motif</span><input id="v-note" autocomplete="off"></label>
        <label class="f" id="f-who" hidden>À qui ?<input id="v-who" autocomplete="off"></label>
        <label class="f" id="f-until" hidden>Fin prévue (facultatif)<input id="v-until" type="date"></label>
        <div class="sub" id="f-date" hidden>Début : aujourd'hui.</div></div>
      <div class="card stack"><h2>2. Le lot</h2>
        <div class="viewport"><video playsinline muted></video></div>
        <form id="manual" class="row"><input id="n" inputmode="numeric" pattern="[0-9]*" placeholder="…ou saisir un n°" autocomplete="off" aria-label="Saisir un numéro de projecteur"><button class="btn">Ajouter</button></form>
        <div id="lotbox" class="chips scan-lot"></div><div id="msg" class="sub" role="status">Scanne les projecteurs un par un.</div></div>
      <div class="card stack"><button class="btn primary" id="go" disabled>Appliquer</button><div id="res" class="stack" role="status"></div></div></div>`;
    const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
    const msg = $('#msg'), box = $('#lotbox'), goB = $<HTMLButtonElement>('#go'), res = $('#res');
    const say = (t: string, bad = false) => { msg.textContent = t; msg.classList.toggle('warn', bad); if (bad) navigator.vibrate?.([250, 100, 250]); };
    const chk = (id: string) => $<HTMLInputElement>(id).checked;

    /** Réglages choisis à l'écran. */
    const changes = (): BatchChanges => {
      const c: BatchChanges = {};
      if (chk('#c-blue')) c.blue = $<HTMLSelectElement>('#v-blue').value === '1';
      if (chk('#c-lamp')) c.lamp = $<HTMLSelectElement>('#v-lamp').value;
      if (chk('#c-st')) c.status = { kind: $<HTMLSelectElement>('#v-st').value as 'dispo' | 'sav' | 'en_pret', note: $<HTMLInputElement>('#v-note').value, who: $<HTMLInputElement>('#v-who').value, until: $<HTMLInputElement>('#v-until').value };
      return c;
    };
    const refresh = () => {
      // cases cochées = champs actifs ; champs de l'état selon SAV / prêt
      $<HTMLSelectElement>('#v-blue').disabled = !chk('#c-blue'); $<HTMLSelectElement>('#v-lamp').disabled = !chk('#c-lamp'); $<HTMLSelectElement>('#v-st').disabled = !chk('#c-st');
      const k = chk('#c-st') ? $<HTMLSelectElement>('#v-st').value : '';
      $('#f-note').hidden = !(k === 'sav' || k === 'en_pret'); $('#l-note').textContent = k === 'sav' ? 'Motif (obligatoire)' : 'Remarque (facultatif)';
      $('#f-who').hidden = k !== 'en_pret'; $('#f-until').hidden = !(k === 'sav' || k === 'en_pret'); $('#f-date').hidden = !(k === 'sav' || k === 'en_pret');
      box.replaceChildren(...(lot.length ? lot.map((n) => { const c = document.createElement('button'); c.type = 'button'; c.className = 'chip'; c.textContent = `${n} ✕`; c.setAttribute('aria-pressed', 'true'); c.setAttribute('aria-label', `Retirer le projecteur ${n} du lot`);
        c.addEventListener('click', () => { lot.splice(lot.indexOf(n), 1); refresh(); }); return c; }) : [Object.assign(document.createElement('span'), { className: 'sub', textContent: 'Lot vide' })]));
      goB.disabled = !lot.length || !!validateChanges(changes(), todayStr()); goB.textContent = lot.length ? `Appliquer à ${lot.length} projecteur${lot.length > 1 ? 's' : ''}` : 'Appliquer';
    };
    root.addEventListener('input', refresh); root.addEventListener('change', refresh);

    const add = (text: string) => {
      const n = parseScan(text);
      if (n === null) { say(`QR non reconnu : « ${text.slice(0, 40)} »`, true); return; }
      if (!view().items.some((i) => i.id === n)) { say(`Projecteur n° ${n} introuvable.`, true); return; }
      if (lot.includes(n)) { say(`N° ${n} est déjà dans le lot.`, true); return; }
      lot.push(n); navigator.vibrate?.(40); cashBeep(); say(`N° ${n} ajouté (${lot.length} dans le lot).`); refresh();
    };
    $('#manual').addEventListener('submit', (e) => { e.preventDefault(); const i = $<HTMLInputElement>('#n'); add(i.value); i.value = ''; });
    let last = '', lastAt = 0;
    const scanner = new QrScanner($<HTMLVideoElement>('video'), (r) => { if (r.data === last && Date.now() - lastAt < 2500) return; last = r.data; lastAt = Date.now(); add(r.data); },
      { returnDetailedScanResult: true, preferredCamera: 'environment', maxScansPerSecond: 8, highlightScanRegion: false });
    startScan(scanner, $<HTMLVideoElement>('video')).catch((e) => say(`Caméra indisponible (${String(e)}). Saisis les numéros à la main.`, true));

    /** Envoie une opération pour un projecteur ; renvoie le message d'erreur ou null. */
    const send = async (n: number, s: BatchStep): Promise<string | null> => {
      const r = s.kind === 'blue' ? await supabase.rpc('set_blue_dot', { p_item: n, p_value: s.value })
        : s.kind === 'lamp' ? await supabase.rpc('set_lamp', { p_item: n, p_lamp: s.lamp })
        : await supabase.rpc('apply_status', { p_event: crypto.randomUUID(), p_item: n, p_status: s.status, p_note: s.note || null, p_at: new Date().toISOString(), p_who: s.who || null, p_from: null, p_until: s.until || null });
      return r.error ? friendlyError(r.error.message, true) : null;
    };
    goB.addEventListener('click', async () => {
      const c = changes(), why = validateChanges(c, todayStr());
      if (why) { say(why, true); return; }
      if (!navigator.onLine) { say('Cette action demande une connexion.', true); return; }
      const inShows = inUpcomingShows(view(), lot, todayStr());
      const text = `Appliquer à ${lot.length} projecteur${lot.length > 1 ? 's' : ''} (n° ${lot.slice().sort((a, b) => a - b).join(', ')}) :\n• ${summarize(view(), c).join('\n• ')}`
        + (inShows && c.status && c.status.kind !== 'dispo' ? `\n\nAttention : ${inShows} de ces projecteurs sont affectés à un spectacle en cours ou à venir.` : '');
      if (!await confirmBox(text, { ok: 'Appliquer' })) return;
      goB.disabled = true; res.replaceChildren();
      const refused: string[] = []; let done = 0, unchanged = 0, stopped = '';
      const ids = lot.slice();
      for (let i = 0; i < ids.length && !stopped; i++) {
        const n = ids[i], p = planItem(view(), n, c);
        say(`Application… ${i + 1} / ${ids.length}`);
        for (const r of p.refused) refused.push(`n° ${n} (${r})`);
        if (!p.steps.length) { unchanged++; continue; }
        let ok = true;
        for (const s of p.steps) {
          const err = await send(n, s);
          if (err) { ok = false; refused.push(`n° ${n} (${err})`); if (isNetworkMessage(err) || /réseau/i.test(err)) { stopped = err; break; } }
        }
        if (ok) done++;
      }
      await pull(); emit();                                          // une seule relecture à la fin
      lot.length = 0;
      const lines = [`${done} projecteur${done > 1 ? 's' : ''} modifié${done > 1 ? 's' : ''}${unchanged ? ` · ${unchanged} déjà dans cet état` : ''}.`];
      if (stopped) lines.push(`Interrompu : ${stopped}`);
      if (refused.length) lines.push(`Refusés : ${refused.join(' ; ')}`);
      res.replaceChildren(...lines.map((t, k) => { const d = document.createElement('div'); d.className = k ? 'sub warn' : 'sub'; d.textContent = t; return d; }));
      say(stopped || refused.length ? 'Terminé avec des refus (voir ci-dessous).' : 'Terminé.', !!(stopped || refused.length));
      toast(lines[0], refused.length || stopped ? 'err' : 'ok'); refresh();
    });
    refresh();
    return () => { scanner.stop(); scanner.destroy(); };
  }
});
