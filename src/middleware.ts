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

  // Allow API routes to handle their own auth
  if (isApiRoute) {
    return supabaseResponse
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
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|logo.png|logo.webp|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
