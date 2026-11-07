export type Status = 'dispo' | 'sav' | 'en_pret';
export type Role = 'lecteur' | 'technicien' | 'admin';

export const STATUSES: Status[] = ['dispo', 'sav', 'en_pret'];
export const STATUS_LABEL: Record<Status, string> = { dispo: 'Disponible', sav: 'SAV', en_pret: 'En prêt' };
export const ROLE_LABEL: Record<Role, string> = { lecteur: 'Lecteur', technicien: 'Technicien', admin: 'Administrateur' };
export const ROLE_RANK: Record<Role, number> = { lecteur: 1, technicien: 2, admin: 3 };

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
}
export interface Fault {
  id: string; item_id: number; description: string | null; reported_by_label: string | null;
  reported_at: string; resolved_at: string | null; resolution: string | null; pending?: boolean;
}
export interface ItemEvent {
  id: string; item_id: number; kind: 'status' | 'fault' | 'fault_resolved';
  status: Status | null; note: string | null; created_by_label: string | null; at: string;
}
export interface Profile { id: string; email: string; role: Role; active: boolean }
export interface AccountRow extends Profile { confirmed: boolean; last_sign_in_at: string | null }

export interface Data {
  families: Family[]; types: ItemType[]; sockets: Socket[]; filterSizes: FilterSize[];
  lamps: Lamp[]; models: Model[]; items: Item[]; faults: Fault[];
}
export const EMPTY_DATA: Data = {
  families: [], types: [], sockets: [], filterSizes: [], lamps: [], models: [], items: [], faults: []
};

/** Action faite sur l'appareil, mise en file d'attente tant que le serveur ne l'a pas confirmée. */
export type Op =
  | { id: string; kind: 'status'; item: number; status: Status; note?: string; at: string }
  | { id: string; kind: 'fault'; item: number; description: string; at: string }
  | { id: string; kind: 'resolve'; fault: string; resolution?: string; at: string };

export interface Rejected { op: Op; message: string }
