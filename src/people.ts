import { supabase } from './supabase';
import type { Person } from './wall';

let cache: Person[] = [];
/** Annuaire (noms seulement) pour citer quelqu'un. En ligne ; garde le dernier résultat sinon. */
export async function loadPeople(): Promise<Person[]> {
  if (!navigator.onLine) return cache;
  const { data, error } = await supabase.rpc('list_people');
  if (!error && Array.isArray(data)) cache = data as Person[];
  return cache;
}
export const knownPeople = (): Person[] => cache;

