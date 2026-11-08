export type Status = 'dispo' | 'sav' | 'en_pret';
export type Role = 'technicien' | 'regisseur' | 'regisseur_general' | 'admin';

export const STATUSES: Status[] = ['dispo', 'sav', 'en_pret'];
/** État affiché : « utilisé » est calculé (projecteur assigné à un spectacle en cours), il ne se règle pas à la main. */
export type DisplayStatus = Status | 'utilise';
export const DISPLAY_STATUSES: DisplayStatus[] = ['dispo', 'utilise', 'sav', 'en_pret'];
export const DISPLAY_LABEL: Record<DisplayStatus, string> = { dispo: 'Disponible', utilise: 'Utilisé', sav: 'SAV', en_pret: 'En prêt' };
export const STATUS_LABEL: Record<Status, string> = { dispo: 'Disponible', sav: 'SAV', en_pret: 'En prêt' };
export const ROLE_LABEL: Record<Role, string> = { technicien: 'Technicien', regisseur: 'Régisseur', regisseur_general: 'Régisseur général', admin: 'Administrateur' };
export const ROLE_RANK: Record<Role, number> = { technicien: 1, regisseur: 2, regisseur_general: 3, admin: 4 };
export const ROLES: Role[] = ['technicien', 'regisseur', 'regisseur_general', 'admin'];

export interface Family { id: string; name: string }
export interface ItemType { id: string; name: string }
export interface Socket { id: string; name: string }
export interface FilterSize { id: string; label: string; sheets_lee: number | null; sheets_rosco: number | null }
export interface Lamp { id: string; name: string; power_w: number | null; temp_k: number | null; socket_id: string | null }
export interface Model {
  id: string; name: string; family_id: string | null; type_id: string | null;
  filter_size_id: string | null; socket_id: string | null; notice_url: string | null;
}
export interface Item {
  id: number; model_id: string; lamp_id: string | null; status: Status; status_at: string;
  last_service: string | null; note: string | null; pending?: boolean;
  /** État affiché (calculé) : « utilisé » si assigné à un spectacle en cours et disponible. */
  eff?: DisplayStatus;
}
export interface Show { id: string; name: string; start_date: string; end_date: string; note: string | null; created_by_label?: string | null }
export interface ShowItem { show_id: string; item_id: number; lamp_id: string | null; added_by_label?: string | null }
export interface Fault {
  id: string; item_id: number; description: string | null; reported_by?: string | null; reported_by_label: string | null;
  reported_at: string; resolved_at: string | null; resolved_by_label?: string | null; resolution: string | null; pending?: boolean;
}
/** Info ajoutée ou description modifiée sur une panne (la déclaration et la résolution sont dans Fault). */
/** Immobilisation d'un projecteur (agenda) : prêt ou SAV. Sans closed_date = en cours ; sans end_date = fin non connue. */
export interface Immo {
  id: string; item_id: number; kind: 'pret' | 'sav' | 'show'; show_id?: string; who: string | null; note: string | null;
  start_date: string; end_date: string | null; closed_date: string | null; created_by_label?: string | null; pending?: boolean;
}
export interface AppLog { id: number; at: string; actor_label: string | null; kind: string; message: string }
export interface FaultLog {
  id: string; fault_id: string; kind: 'note' | 'edit'; text: string; old_text: string | null;
  by_label: string | null; at: string; pending?: boolean;
}
export interface ItemEvent {
  id: string; item_id: number; kind: 'status' | 'fault' | 'fault_resolved';
  status: Status | null; note: string | null; created_by_label: string | null; at: string;
}
export interface Profile { id: string; email: string; role: Role; active: boolean; first_name: string; last_name: string }
export const fullName = (p: { first_name?: string; last_name?: string; email: string }): string =>
  [p.first_name, p.last_name].map((s) => (s ?? '').trim()).filter(Boolean).join(' ') || p.email;
export interface AccountRow extends Profile { confirmed: boolean; last_sign_in_at: string | null }

export interface Data {
  families: Family[]; types: ItemType[]; sockets: Socket[]; filterSizes: FilterSize[];
  lamps: Lamp[]; models: Model[]; items: Item[]; faults: Fault[]; faultLog: FaultLog[]; immos: Immo[]; shows: Show[]; showItems: ShowItem[];
}
export const EMPTY_DATA: Data = {
  families: [], types: [], sockets: [], filterSizes: [], lamps: [], models: [], items: [], faults: [], faultLog: [], immos: [], shows: [], showItems: []
};

/** Action faite sur l'appareil, mise en file d'attente tant que le serveur ne l'a pas confirmée. */
export type Op =
  | { id: string; kind: 'status'; item: number; status: Status; note?: string; who?: string; from?: string; until?: string; at: string }
  | { id: string; kind: 'fault'; item: number; description: string; at: string }
  | { id: string; kind: 'resolve'; fault: string; resolution?: string; at: string }
  | { id: string; kind: 'fault_note'; fault: string; text: string; at: string }
  | { id: string; kind: 'fault_edit'; fault: string; description: string; at: string };

export interface Rejected { op: Op; message: string }
