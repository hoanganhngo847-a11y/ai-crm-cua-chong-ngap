import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

type CookieOptions = Parameters<Awaited<ReturnType<typeof cookies>>['set']>[2];

/**
 * Server Supabase Client (Zone 2 - Trusted Server App Router)
 *
 * Rules:
 * - Strictly server-only: cannot be imported into client components.
 * - Uses anon key and the incoming user's session cookies.
 * - Executes in Postgres under the authenticated user's JWT context (auth.uid()).
 * - Fully subject to Row Level Security (RLS) in public schema.
 */
export async function createClient() {
  let cookieStore: {
    getAll: () => Array<{ name: string; value: string }>;
    set: (name: string, value: string, options?: CookieOptions) => void;
  };

  try {
    cookieStore = await cookies();
  } catch {
    // When running outside Next.js request scope (e.g. test suites or CLI)
    const map = new Map<string, { name: string; value: string; options?: CookieOptions }>();
    cookieStore = {
      getAll() {
        return Array.from(map.values()).map((c) => ({ name: c.name, value: c.value }));
      },
      set(name: string, value: string, options?: CookieOptions) {
        map.set(name, { name, value, options });
      },
    };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.');
  }

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options?: CookieOptions }>) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // In Next.js Server Components, setAll may throw because cookies cannot be
          // set during render. This is safely caught as session refresh is handled in proxy.ts.
        }
      },
    },
  });
}
