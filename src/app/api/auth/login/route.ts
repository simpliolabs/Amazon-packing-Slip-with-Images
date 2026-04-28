import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { logAudit } from '@/lib/audit'

const MAX_ATTEMPTS = 5
const LOCKOUT_WINDOW_MINUTES = 30

/**
 * POST /api/auth/login
 * Server-side login with account lockout after 5 failed attempts.
 * Amazon Credential Management 1.4 compliance.
 */
export async function POST(request: NextRequest) {
  const { email, password } = await request.json()

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') || 'unknown'
  const userAgent = request.headers.get('user-agent') || 'unknown'

  // Use service role to check login attempts (login_attempts table is restricted)
  const adminSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  // Check if account is locked (5+ failed attempts in last 30 minutes)
  const lockoutCutoff = new Date(Date.now() - LOCKOUT_WINDOW_MINUTES * 60 * 1000).toISOString()

  const { data: recentAttempts } = await adminSupabase
    .from('login_attempts')
    .select('id')
    .eq('email', email.toLowerCase())
    .eq('success', false)
    .gte('created_at', lockoutCutoff)

  const failedCount = recentAttempts?.length || 0

  if (failedCount >= MAX_ATTEMPTS) {
    // Log the lockout event
    await logAudit({
      userId: null,
      action: 'user.login' as any,
      resourceType: 'auth',
      resourceId: email,
      details: { reason: 'account_locked', failedAttempts: failedCount, ip },
      ipAddress: ip,
      userAgent,
    })

    return NextResponse.json({
      error: 'Account temporarily locked due to too many failed attempts. Please try again in 30 minutes.',
      locked: true,
      lockoutMinutes: LOCKOUT_WINDOW_MINUTES,
    }, { status: 423 })
  }

  // Attempt login using a server-side Supabase client with cookie handling
  let supabaseResponse = NextResponse.json({ success: true })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            supabaseResponse.cookies.set(name, value, options)
          })
        },
      },
    }
  )

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    // Record failed attempt
    await adminSupabase.from('login_attempts').insert({
      email: email.toLowerCase(),
      ip_address: ip,
      success: false,
    })

    const newFailedCount = failedCount + 1
    const remainingAttempts = MAX_ATTEMPTS - newFailedCount

    // Log failed login
    await logAudit({
      userId: null,
      action: 'user.login' as any,
      resourceType: 'auth',
      resourceId: email,
      details: { reason: 'invalid_credentials', failedAttempts: newFailedCount, ip },
      ipAddress: ip,
      userAgent,
    })

    if (newFailedCount >= MAX_ATTEMPTS) {
      return NextResponse.json({
        error: 'Account temporarily locked due to too many failed attempts. Please try again in 30 minutes.',
        locked: true,
        lockoutMinutes: LOCKOUT_WINDOW_MINUTES,
      }, { status: 423 })
    }

    return NextResponse.json({
      error: error.message,
      remainingAttempts,
    }, { status: 401 })
  }

  // Successful login — record success and clear failed attempts
  await adminSupabase.from('login_attempts').insert({
    email: email.toLowerCase(),
    ip_address: ip,
    success: true,
  })

  // Clear old failed attempts on successful login
  await adminSupabase
    .from('login_attempts')
    .delete()
    .eq('email', email.toLowerCase())
    .eq('success', false)

  // Log successful login
  await logAudit({
    userId: data.user?.id || null,
    action: 'user.login',
    resourceType: 'auth',
    resourceId: email,
    details: { ip, success: true },
    ipAddress: ip,
    userAgent,
  })

  // Check MFA enrollment status
  const { data: factors } = await supabase.auth.mfa.listFactors()
  const hasMFA = factors?.totp && factors.totp.length > 0
  const verifiedFactors = factors?.totp?.filter(f => f.status === 'verified') || []

  // Check password expiration
  const { data: profile } = await adminSupabase
    .from('user_profiles')
    .select('password_changed_at, mfa_enrolled')
    .eq('id', data.user!.id)
    .single()

  let passwordExpired = false
  if (profile?.password_changed_at) {
    const changedAt = new Date(profile.password_changed_at)
    const daysSinceChange = (Date.now() - changedAt.getTime()) / (1000 * 60 * 60 * 24)
    passwordExpired = daysSinceChange > 365
  }

  // Build response with session cookies
  const responseData = {
    success: true,
    user: data.user,
    session: data.session,
    mfaRequired: verifiedFactors.length > 0,
    mfaEnrolled: hasMFA,
    passwordExpired,
  }

  // Create a new response with the data AND the cookies
  const finalResponse = NextResponse.json(responseData)

  // Copy cookies from supabaseResponse to finalResponse
  supabaseResponse.cookies.getAll().forEach(cookie => {
    finalResponse.cookies.set(cookie.name, cookie.value, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    })
  })

  return finalResponse
}
