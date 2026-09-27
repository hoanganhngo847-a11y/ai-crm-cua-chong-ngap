import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser Supabase Client (Zone 1 - Untrusted Client Zone)
 *
 * Rules:
 * - Uses only anon key and public Supabase URL.
 * - NEVER contains or imports SUPABASE_SERVICE_ROLE_KEY.
 * - Subject to PostgreSQL RLS on every query.
 */
export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.');
  }

  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
