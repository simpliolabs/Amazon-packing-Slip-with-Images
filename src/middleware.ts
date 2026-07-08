import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Refresh session if expired
  const { data: { user } } = await supabase.auth.getUser()

  const pathname = request.nextUrl.pathname

  // Public routes that don't require auth
  const publicRoutes = ['/login', '/auth/callback', '/auth/confirm', '/auth/invite', '/set-password']
  const isPublicRoute = publicRoutes.some((route) => pathname.startsWith(route))
  const isApiRoute = pathname.startsWith('/api/')
  // MFA routes handle their own auth state — they must be accessible for AAL1 sessions
  // (user logged in with password but MFA not yet verified). Blocking them causes a redirect loop.
  const isMFARoute = pathname.startsWith('/mfa/')
  const isPasswordResetRoute = pathname === '/reset-password'

  // ── API auth gate (2026-07-08) ────────────────────────────────────────────
  // This used to pass ALL /api/* through ("routes handle their own auth") — but ~30 routes had
  // NO auth at all, including live-Amazon-write routes (push-content, relink, fix-capacity) and
  // money-spend routes (ai-recommendations, rank-analysis, intelligence). One gate here fails
  // CLOSED for every current and future route; routes' own checks remain as defense-in-depth.
  // Accepted credentials, in order:
  //   1) Supabase cookie session — every browser page (same-origin fetches carry sb-* cookies).
  //   2) CRON_SECRET via x-cron-secret or Authorization — external schedulers + the
  //      instrumentation self-cron + the cron routes' internal verify-push self-fetches.
  //      Checked BEFORE JWT validation (scheduler bearers are the raw secret, not a JWT).
  //   3) Supabase Bearer JWT — ops scripts / direct-POST verification (adds one auth call
  //      only when neither cookie nor cron secret matched).
  if (isApiRoute) {
    // Public by design: the login endpoint and the deploy build-identity check.
    if (pathname === '/api/auth/login' || pathname === '/api/health') {
      return supabaseResponse
    }
    // Parse Authorization ONCE, case-insensitively (RFC 7235: auth-scheme is case-insensitive —
    // a scheduler sending "bearer <secret>" must not silently 401 forever).
    const authHeader = request.headers.get('authorization') ?? ''
    const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? ''
    if (user) {
      // MFA PARITY (adversarial 2026-07-08): pages force an AAL1 session of an MFA-enrolled user
      // to /mfa/verify — the API must not accept the same session, or a phished password drives
      // the whole API (Amazon writes, AI spend) with MFA bypassed. Local JWT-claims read, no
      // network (same call as the page gate below). /api/auth/* stays reachable at AAL1: those
      // endpoints ARE the auth flow (setup-profile during password reset, the MFA challenge).
      if (!pathname.startsWith('/api/auth/')) {
        const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
        if (aalData?.nextLevel === 'aal2' && aalData?.currentLevel === 'aal1') {
          return NextResponse.json({ error: 'MFA required' }, { status: 401 })
        }
      }
      return supabaseResponse
    }
    // Machine credential. Plain === (not constant-time) is an accepted risk: CRON_SECRET is a
    // long high-entropy string; a byte-by-byte timing oracle over internet jitter is not practical.
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && (
      request.headers.get('x-cron-secret') === cronSecret ||
      bearer === cronSecret
    )) {
      return supabaseResponse
    }
    // Supabase Bearer JWT — only attempt validation on a JWT-SHAPED token, so credential-spraying
    // scanners don't fan out one Supabase Auth round-trip per probe.
    if (bearer && bearer.split('.').length === 3) {
      const { data, error } = await supabase.auth.getUser(bearer)
      if (!error && data.user) {
        // MFA parity for explicit tokens too: an MFA-enrolled user's token must carry aal2.
        const enrolled = (data.user.factors ?? []).some((f) => (f as { status?: string }).status === 'verified')
        if (enrolled) {
          try {
            const payload = JSON.parse(atob(bearer.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { aal?: string }
            if (payload?.aal !== 'aal2') return NextResponse.json({ error: 'MFA required' }, { status: 401 })
          } catch {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
          }
        }
        return supabaseResponse
      }
    }
    // Navigation-style API GETs (Amazon OAuth connect/callback are top-level browser navigations)
    // degrade to the login page instead of a raw JSON 401 dead-end mid-OAuth.
    if (pathname.startsWith('/api/amazon/')) {
      return NextResponse.redirect(new URL('/login?redirectTo=/settings', request.url))
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Allow MFA routes to pass through — they handle their own session checks client-side
  if (isMFARoute) {
    return supabaseResponse
  }

  // Redirect unauthenticated users to login
  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('redirectTo', pathname)
    return NextResponse.redirect(url)
  }

  // Redirect authenticated users away from login
  if (user && pathname === '/login') {
    return NextResponse.redirect(new URL('/', request.url))
  }

  // For authenticated users on protected routes, check MFA
  if (user && !isPublicRoute && !isMFARoute && !isPasswordResetRoute) {
    // getAuthenticatorAssuranceLevel reads JWT claims locally — no extra network call.
    // nextLevel === 'aal2' means the user has MFA enrolled but this session is only AAL1.
    // nextLevel === 'aal1' means no MFA factors enrolled at all.
    // This replaces the previous listFactors() call which was making an extra network
    // request on every page load and causing the auth API flood.
    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    const currentLevel = aalData?.currentLevel ?? null
    const nextLevel = aalData?.nextLevel ?? null

    // User has MFA enrolled but hasn't verified this session → send to verify
    if (nextLevel === 'aal2' && currentLevel === 'aal1') {
      const url = request.nextUrl.clone()
      url.pathname = '/mfa/verify'
      return NextResponse.redirect(url)
    }

    // No MFA enrolled → send to enroll (policy requires MFA for all users)
    if (nextLevel === 'aal1' && currentLevel === 'aal1' && !pathname.startsWith('/mfa/enroll')) {
      const url = request.nextUrl.clone()
      url.pathname = '/mfa/enroll'
      return NextResponse.redirect(url)
    }
  }

  return supabaseResponse
}

export const config = {
  // TWO entries, OR'd (adversarial 2026-07-08): the image-extension exclusion used to apply to
  // /api/* too, so /api/fba/rank-analysis/x.png SKIPPED the middleware entirely — a dynamic API
  // route's [param] can end in .png and would bypass the auth gate. Entry 1 matches ALL of /api
  // unconditionally; entry 2 keeps the image skip for pages (and excludes api/ to avoid double
  // evaluation).
  matcher: [
    '/api/:path*',
    '/((?!api/|_next/static|_next/image|favicon.ico|logo.png|logo.webp|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
