import assert from 'node:assert/strict';
// faux DOM minimal pour vérifier la logique du flash
const kids: any[] = [];
const zone: any = { querySelector: (q: string) => kids.find((k) => q === '.torch-btn' && k.className === 'torch-btn') ?? null, appendChild: (k: any) => kids.push(k) };
(globalThis as any).document = { createElement: () => { const h: Record<string, () => void> = {}; return { setAttribute() {}, addEventListener: (e: string, f: () => void) => { h[e] = f; }, click: () => h.click(), className: '', textContent: '' }; } };
import { startScan } from '../src/ui/torch';
let on = false; const calls: string[] = [];
const sc: any = { start: async () => { calls.push('start'); }, hasFlash: async () => true, turnFlashOn: async () => { on = true; calls.push('on'); }, isFlashOn: () => on, toggleFlash: async () => { on = !on; } };
await startScan(sc, { parentElement: zone } as any);
assert.deepEqual(calls, ['start', 'on']); assert.equal(kids.length, 1); assert.match(kids[0].textContent, /oui/);   // allumé par défaut + bouton
kids[0].click(); await new Promise((r) => setTimeout(r)); assert.equal(on, false); assert.match(kids[0].textContent, /non/);   // le bouton coupe
await startScan(sc, { parentElement: zone } as any); assert.equal(kids.length, 1);                                             // pas de doublon
const sc2: any = { ...sc, hasFlash: async () => false }; const k2: any[] = []; await startScan(sc2, { parentElement: { querySelector: () => null, appendChild: (k: any) => k2.push(k) } } as any); assert.equal(k2.length, 0);   // sans flash : rien
const sc3: any = { ...sc, start: async () => { throw new Error('refus'); } }; await assert.rejects(startScan(sc3, { parentElement: zone } as any));   // l'erreur caméra remonte à l'appelant
console.log('torch OK');
