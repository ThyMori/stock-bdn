import { createClient } from '@supabase/supabase-js';

// Lien d'invitation / de réinitialisation : Supabase y place "#access_token=…&type=invite|recovery".
// On le note avant que la bibliothèque ne nettoie l'URL.
export const authFlow: 'invite' | 'recovery' | null =
  (/[#&]type=(invite|recovery)\b/.exec(location.hash)?.[1] as 'invite' | 'recovery' | undefined) ?? null;

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = Boolean(url && key);
export const supabase = createClient(url || 'http://localhost', key || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
