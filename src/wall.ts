import { esc } from './logic';

/** Une couleur par personne, stable (déduite de l'identifiant du compte). */
export const PERSON_COLORS = ['#1d4ed8', '#c2410c', '#0f766e', '#be185d', '#7e22ce', '#4d7c0f', '#b91c1c', '#0e7490', '#a16207', '#4338ca', '#047857', '#9d174d'];
export function personColor(id: string | null | undefined): string {
  if (!id) return '#475569';
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PERSON_COLORS[h % PERSON_COLORS.length];
}

export interface Person { id: string; label: string }

const TOKEN = /@\[([^\]]+)\]\(u:([0-9a-f-]{36})\)/g;
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Texte saisi (« @Marie Durand ») → texte stocké (« @[Marie Durand](u:uuid) »). */
export function fromEditable(text: string, people: Person[]): string {
  let out = text;
  for (const p of [...people].sort((a, b) => b.label.length - a.label.length)) {
    out = out.replace(new RegExp(`@${reEsc(p.label)}(?![\\p{L}\\p{N}])`, 'giu'), `@[${p.label}](u:${p.id})`);
  }
  return out;
}
/** Texte stocké → texte éditable. */
export const toEditable = (body: string): string => body.replace(TOKEN, '@$1');
/** Personnes citées dans un message stocké. */
export const mentionedIds = (body: string): string[] => [...body.matchAll(TOKEN)].map((m) => m[2]);
/** Projecteurs cités (#219). */
export const mentionedItems = (body: string): number[] => [...body.replace(TOKEN, '').matchAll(/(?<![&\w])#(\d{1,4})\b/g)].map((m) => Number(m[1]));

/** Corps d'un message en HTML sûr : personnes en pastille de leur couleur, projecteurs en lien. */
export function renderBody(body: string): string {
  return esc(body)
    .replace(/@\[([^\]]+)\]\(u:([0-9a-f-]{36})\)/g, (_m, label: string, id: string) => `<span class="mention" style="--pc:${personColor(id)}">@${label}</span>`)
    .replace(/(?<![&\w])#(\d{1,4})\b/g, '<a class="pitem" href="#/item/$1">#$1</a>')
    .replace(/(?<![\w@&])@all\b/gi, '<span class="mention" style="--pc:#b91c1c">@all</span>')
    .replace(/\n/g, '<br>');
}
