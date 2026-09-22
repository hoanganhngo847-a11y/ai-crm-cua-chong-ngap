import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Next.js 16 Proxy (Replaces deprecated middleware.ts)
 *
 * Rules (AUTH_DESIGN.md Section 8.2 & Section 5.2):
 * - Runs on Node.js runtime.
 * - Acts as coarse request gating:
 *     1. Automatically refreshes session tokens via supabase.auth.getUser().
 *     2. Redirects unauthenticated requests accessing protected routes to /login.
 *     3. Redirects authenticated requests accessing public auth routes to /(dashboard).
 * - Detailed authorization (fine-grained role & company checks) is performed at
 *   Server Components, Server Actions, and PostgreSQL RLS.
 */
export async function proxy(request: NextRequest) {
  request.headers.set('x-pathname', request.nextUrl.pathname);

  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return response;
  }

type CookieOptions = Parameters<NextResponse['cookies']['set']>[2];

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options?: CookieOptions }>) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({
          request,
        });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // IMPORTANT: getUser() triggers token refresh if expired
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  // Protected route patterns
  const isProtectedRoute =
    pathname.startsWith('/admin') ||
    pathname.startsWith('/crm') ||
    pathname.startsWith('/field') ||
    pathname.startsWith('/account');

  // Public auth route patterns
  const isAuthRoute =
    pathname === '/login' ||
    pathname === '/forgot-password' ||
    pathname === '/reset-password';

  if (isProtectedRoute && !user) {
    const redirectUrl = new URL('/login', request.url);
    redirectUrl.searchParams.set('redirect_to', pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (isAuthRoute && user) {
    return NextResponse.redirect(new URL('/crm', request.url));
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for:
     * - api routes
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt
     */
    '/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};

export default proxy;
