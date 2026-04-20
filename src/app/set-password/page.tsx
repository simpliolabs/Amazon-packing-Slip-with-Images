'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'

/**
 * /set-password page
 *
 * Secure invite flow — Step 3:
 * The user arrives here AUTHENTICATED (session set by /auth/callback).
 * They set their password using supabase.auth.updateUser({ password }),
 * which uses their OWN session JWT — no admin keys involved.
 * Then we call /api/auth/setup-profile to clear the invite_token.
 */
function SetPasswordContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [checkingAuth, setCheckingAuth] = useState(true)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [inviteToken, setInviteToken] = useState<string | null>(null)

  const supabase = createClient()

  useEffect(() => {
    const token = searchParams.get('token')
    const error = searchParams.get('error')

    if (error === 'invite_expired') {
      setErrorMessage('This invite link has expired or was already used. Please ask your admin to send a new invite.')
      setCheckingAuth(false)
      return
    } else if (error === 'invalid_link') {
      setErrorMessage('This invite link is invalid. Please ask your admin to send a new invite.')
      setCheckingAuth(false)
      return
    } else if (error) {
      setErrorMessage('Something went wrong. Please ask your admin to send a new invite.')
      setCheckingAuth(false)
      return
    }

    if (token) {
      setInviteToken(token)
    }

    // Check if user is authenticated (session should be set by /auth/callback)
    async function checkSession() {
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError || !user) {
        // Not authenticated — they need to use the invite link first
        setErrorMessage('You need to use your invite link to access this page. Please check your invite link and try again.')
        setCheckingAuth(false)
        return
      }
      setIsAuthenticated(true)
      setUserEmail(user.email || null)
      setCheckingAuth(false)
    }

    checkSession()
  }, [searchParams, supabase.auth])

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault()

    if (password.length < 6) {
      toast.error('Password must be at least 6 characters')
      return
    }

    if (password !== confirmPassword) {
      toast.error('Passwords do not match')
      return
    }

    setLoading(true)

    try {
      // 1. Set password using the user's OWN authenticated session JWT
      // This is 100% secure — no admin keys involved
      const { error: updateError } = await supabase.auth.updateUser({
        password: password,
      })

      if (updateError) {
        console.error('updateUser error:', updateError)
        toast.error(updateError.message || 'Failed to set password')
        setLoading(false)
        return
      }

      // 2. Call setup-profile to clear invite_token and ensure profile exists
      try {
        await fetch('/api/auth/setup-profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      } catch {
        // Non-critical — profile may already exist
        console.warn('setup-profile call failed, continuing...')
      }

      toast.success('Password set successfully! Redirecting to dashboard…')

      // 3. Redirect to dashboard — user is already authenticated
      setTimeout(() => {
        router.push('/')
      }, 1500)
    } catch {
      toast.error('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  // Loading state while checking auth
  if (checkingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#2E9CE6]"></div>
          <div className="text-sm text-gray-500">Verifying your session…</div>
        </div>
      </div>
    )
  }

  // Show error state
  if (errorMessage || !isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-md text-center">
          <div className="flex justify-center mb-8">
            <Image
              src="/logo.png"
              alt="TheCEO.Store"
              width={200}
              height={90}
              className="object-contain"
              priority
            />
          </div>
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
            <h1 className="text-xl font-bold text-gray-900 mb-2">
              Invite Link Issue
            </h1>
            <p className="text-sm text-gray-500 mb-6">
              {errorMessage || 'You need to use your invite link to access this page.'}
            </p>
            <a
              href="/login"
              className="inline-block py-2.5 px-6 bg-[#2E9CE6] hover:bg-[#1A7BC4] text-white font-semibold rounded-lg text-sm transition-colors"
            >
              Go to Login
            </a>
          </div>
        </div>
      </div>
    )
  }

  // Show password form — user is authenticated
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <Image
            src="/logo.png"
            alt="TheCEO.Store"
            width={200}
            height={90}
            className="object-contain"
            priority
          />
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">
            Welcome!
          </h1>
          <p className="text-sm text-gray-500 mb-6">
            Set your password to access the FBM Packing Slip Portal.
            {userEmail && (
              <span className="block mt-1 text-xs text-gray-400">
                Signed in as {userEmail}
              </span>
            )}
          </p>

          <form onSubmit={handleSetPassword} className="space-y-4">
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                New Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                autoComplete="new-password"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent transition"
                placeholder="At least 6 characters"
              />
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Confirm Password
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={6}
                autoComplete="new-password"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent transition"
                placeholder="Re-enter your password"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-[#2E9CE6] hover:bg-[#1A7BC4] disabled:opacity-60 text-white font-semibold rounded-lg text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:ring-offset-2"
            >
              {loading ? 'Setting password…' : 'Set Password & Continue'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          FBM Packing Slip Portal — Internal Use Only
        </p>
      </div>
    </div>
  )
}

export default function SetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <div className="flex flex-col items-center gap-3">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#2E9CE6]"></div>
            <div className="text-sm text-gray-500">Loading…</div>
          </div>
        </div>
      }
    >
      <SetPasswordContent />
    </Suspense>
  )
}
