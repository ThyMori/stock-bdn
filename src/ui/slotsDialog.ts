// Fenêtre « Répartir » : combien de projecteurs par zone, et au besoin par position précise (zone dépliée).
import { positionsOfZone, ZONES } from '../zones';
import { ZONE_ORDER, slotsTotal, validateSlots, zoneCount } from '../slots';
import type { Slot } from '../slots';

/** Affiche la fenêtre ; renvoie la nouvelle répartition, ou null si on annule. */
export function openSlots(title: string, qty: number, start: Slot[]): Promise<Slot[] | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog'); dlg.className = 'dlg slots';
    const form = document.createElement('form'); form.method = 'dialog'; form.className = 'stack'; dlg.appendChild(form);
    const label = (z: string) => ZONES.find(([k]) => k === z)?.[1] ?? z;
    // état : un nombre par zone et un nombre par position
    const zn: Record<string, number> = {}, pn: Record<string, number> = {};
    for (const z of ZONE_ORDER) zn[z] = zoneCount(start, z);
    for (const s of start) if (s.position !== null) pn[s.zone + '|' + s.position] = s.qty;
    const h = document.createElement('h2'); h.textContent = title; h.tabIndex = -1; form.appendChild(h);
    const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = `${qty} projecteur${qty > 1 ? 's' : ''} demandé${qty > 1 ? 's' : ''}. Ce qui n'est pas réparti reste « sans zone précise ».`; form.appendChild(sub);
    const sum = document.createElement('div'); sum.className = 'slot-sum'; sum.setAttribute('role', 'status');
    const err = document.createElement('div'); err.className = 'sub warn'; err.setAttribute('role', 'alert');
    const ok = document.createElement('button'); ok.className = 'btn primary grow'; ok.value = 'ok'; ok.textContent = 'Enregistrer';
    // champ numérique avec boutons − et + (zones tactiles de 44 px) ; renvoie l'ensemble à poser dans la ligne
    const numInput = (val: number, aria: string, on: (n: number) => void) => {
      const wrap = document.createElement('span'); wrap.className = 'slot-step';
      const i = document.createElement('input'); i.inputMode = 'numeric'; i.pattern = '[0-9]*'; i.value = val ? String(val) : ''; i.placeholder = '0'; i.setAttribute('aria-label', aria); i.className = 'slot-n';
      const read = () => { const n = parseInt(i.value, 10); return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 0; };
      i.addEventListener('input', () => { on(read()); refresh(); });
      i.addEventListener('focus', () => i.select());
      const btn = (txt: string, delta: number, label: string) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn slot-pm'; b.textContent = txt; b.setAttribute('aria-label', `${label} : ${aria}`);
        b.addEventListener('click', () => { const n = Math.max(0, Math.min(500, read() + delta)); i.value = n ? String(n) : ''; on(n); refresh(); });   // met à jour le champ, l'état et le total
        return b;
      };
      wrap.append(btn('−', -1, 'Moins'), i, btn('+', 1, 'Plus'));
      return wrap;
    };
    for (const z of ZONE_ORDER) {
      const box = document.createElement('div'); box.className = 'slot-zone';
      const row = document.createElement('div'); row.className = 'row';
      const name = document.createElement('b'); name.className = 'grow'; name.textContent = label(z);
      const hasPos = positionsOfZone(z).some((p) => pn[z + '|' + p]);
      const tog = document.createElement('button'); tog.type = 'button'; tog.className = 'btn'; tog.textContent = 'Positions ▸'; tog.setAttribute('aria-expanded', String(hasPos));
      row.append(name, numInput(zn[z], `Nombre de projecteurs : ${label(z)}`, (n) => { zn[z] = n; }), tog);
      const list = document.createElement('div'); list.className = 'slot-pos'; list.hidden = !hasPos;
      for (const p of positionsOfZone(z)) {
        const r = document.createElement('label'); r.className = 'row slot-prow'; const t = document.createElement('span'); t.className = 'grow'; t.textContent = p;
        r.append(t, numInput(pn[z + '|' + p] ?? 0, `Nombre de projecteurs à la position ${p}`, (n) => { if (n) pn[z + '|' + p] = n; else delete pn[z + '|' + p]; }));
        list.appendChild(r);
      }
      tog.addEventListener('click', () => { list.hidden = !list.hidden; tog.setAttribute('aria-expanded', String(!list.hidden)); tog.textContent = list.hidden ? 'Positions ▸' : 'Positions ▾'; });
      if (hasPos) tog.textContent = 'Positions ▾';
      box.append(row, list); form.appendChild(box);
    }
    const current = (): Slot[] => {
      const out: Slot[] = [];
      for (const z of ZONE_ORDER) {
        if (zn[z] > 0) out.push({ zone: z, position: null, qty: zn[z] });
        for (const p of positionsOfZone(z)) if (pn[z + '|' + p] > 0) out.push({ zone: z, position: p, qty: pn[z + '|' + p] });
      }
      return out;
    };
    function refresh() {
      const cur = current(), e = validateSlots(cur, qty), tot = slotsTotal(cur);
      sum.textContent = `Réparti : ${tot} / ${qty} · sans zone précise : ${Math.max(0, qty - tot)}`;
      err.textContent = e ?? ''; ok.disabled = !!e;
    }
    const row = document.createElement('div'); row.className = 'row';
    const no = document.createElement('button'); no.className = 'btn'; no.value = 'cancel'; no.textContent = 'Annuler'; no.setAttribute('formnovalidate', '');
    row.append(ok, no);
    const foot = document.createElement('div'); foot.className = 'slot-foot stack'; foot.append(sum, err, row); form.appendChild(foot);   // pied collé en bas : toujours visible
    document.body.appendChild(dlg); refresh();
    let done = false;
    const finish = (v: Slot[] | null) => { if (done) return; done = true; dlg.close(); dlg.remove(); resolve(v); };
    form.addEventListener('submit', (e) => { e.preventDefault(); finish((e as SubmitEvent).submitter === ok && !ok.disabled ? current() : null); });
    dlg.addEventListener('cancel', () => finish(null));
    dlg.showModal(); h.focus();
  });
}
