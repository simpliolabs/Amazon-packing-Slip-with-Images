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
  const isMFARoute = pathname.startsWith('/mfa/')
  const isPasswordResetRoute = pathname === '/reset-password'

  // Allow API routes to handle their own auth
  if (isApiRoute) {
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

  // For authenticated users on protected routes, check MFA and password expiration
  if (user && !isPublicRoute && !isMFARoute && !isPasswordResetRoute) {
    // Check MFA: if user has verified TOTP factors, verify AAL level
    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    const currentLevel = aalData?.currentLevel ?? null

    // If user has MFA enrolled but current session is only AAL1, redirect to verify
    const { data: factors } = await supabase.auth.mfa.listFactors()
    const verifiedFactors = factors?.totp?.filter(f => f.status === 'verified') || []

    if (verifiedFactors.length > 0 && currentLevel === 'aal1') {
      // User has MFA but hasn't verified this session
      const url = request.nextUrl.clone()
      url.pathname = '/mfa/verify'
      return NextResponse.redirect(url)
    }

    // If user has NO MFA enrolled, redirect to enroll (required by policy)
    // Skip this check for the enroll page itself
    if (verifiedFactors.length === 0 && !pathname.startsWith('/mfa/enroll')) {
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
