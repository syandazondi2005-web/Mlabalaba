import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

// If the env vars are missing, this still creates a client so the app
// doesn't crash on import — calls will just fail, and the UI checks
// isSupabaseConfigured before trying to use them.
export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey)
  : null;
