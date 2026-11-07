export interface View {
  /** Construit la page dans `root`. Peut renvoyer une fonction de nettoyage (caméra, timers…). */
  mount(root: HTMLElement): void | (() => void);
  /** Appelé quand les données ou l'état de synchro changent. Absent = la page ne se redessine pas. */
  update?(root: HTMLElement): void;
}
export type ViewFactory = (params: string[], query: URLSearchParams) => View;

export const go = (hash: string) => { location.hash = hash; };
export function parseHash(): { segs: string[]; query: URLSearchParams } {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { segs: path.split('/').filter(Boolean), query: new URLSearchParams(qs ?? '') };
}
