import 'server-only';
import { createClient } from '@supabase/supabase-js';

/**
 * Trusted Admin / Service-Role Client
 *
 * Rules:
 * - Strictly server-only: cannot be imported into client components.
 * - Uses SUPABASE_SERVICE_ROLE_KEY (must never have NEXT_PUBLIC_ prefix).
 * - Bypasses PostgreSQL RLS.
 *
 * CRITICAL SECURITY INVARIANT:
 * Service role execution is NOT user authorization. Any server operation
 * initiated by a user that leverages the admin client MUST independently verify:
 *   1. Verified identity of caller (getUser())
 *   2. Active user_profiles status
 *   3. Active company membership
 *   4. Appropriate application role
 *   5. Resource-level ownership and scope
 */
export function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is missing.');
  }

  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing.');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
