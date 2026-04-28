'use client'

import { useState, useEffect, useMemo, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { validatePassword, getPasswordStrength } from '@/lib/auth/passwordValidator'

/**
 * /set-password page
 *
 * Secure invite flow — Step 3:
 * The user arrives here AUTHENTICATED (session set by /auth/callback).
 * They set their password using supabase.auth.updateUser({ password }),
 * which uses their OWN session JWT — no admin keys involved.
 * Then we call /api/auth/setup-profile to clear the invite_token.
 *
 * Password must meet Amazon Credential Management 1.4 requirements:
 * - Minimum 12 characters
 * - Upper + lower case + numbers + special characters
 * - No username parts
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
  const [fullName, setFullName] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [inviteToken, setInviteToken] = useState<string | null>(null)
  const [showRequirements, setShowRequirements] = useState(false)

  const supabase = createClient()

  // Real-time password validation
  const validation = useMemo(
    () => validatePassword(password, userEmail, fullName),
    [password, userEmail, fullName]
  )
  const strength = useMemo(
    () => getPasswordStrength(validation.checks),
    [validation.checks]
  )

  useEffect(() => {
    const token = searchParams.get('token')
    const error = searchParams.get('error')
    const reason = searchParams.get('reason')

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
        setErrorMessage('You need to use your invite link to access this page. Please check your invite link and try again.')
        setCheckingAuth(false)
        return
      }
      setIsAuthenticated(true)
      setUserEmail(user.email || null)
      setFullName(user.user_metadata?.full_name || null)
      setCheckingAuth(false)
    }

    checkSession()
  }, [searchParams, supabase.auth])

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault()

    // Validate password complexity
    if (!validation.valid) {
      toast.error(validation.errors[0] || 'Password does not meet requirements')
      return
    }

    if (password !== confirmPassword) {
      toast.error('Passwords do not match')
      return
    }

    setLoading(true)

    try {
      // 1. Set password using the user's OWN authenticated session JWT
      const { error: updateError } = await supabase.auth.updateUser({
        password: password,
      })

      if (updateError) {
        console.error('updateUser error:', updateError)
        toast.error(updateError.message || 'Failed to set password')
        setLoading(false)
        return
      }

      // 2. Call setup-profile to clear invite_token and record password_changed_at
      try {
        await fetch('/api/auth/setup-profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passwordChanged: true }),
        })
      } catch {
        console.warn('setup-profile call failed, continuing...')
      }

      toast.success('Password set successfully! Redirecting…')

      // 3. Redirect to MFA enrollment (required by policy)
      setTimeout(() => {
        router.push('/mfa/enroll')
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
                onChange={(e) => { setPassword(e.target.value); setShowRequirements(true) }}
                onFocus={() => setShowRequirements(true)}
                required
                minLength={12}
                autoComplete="new-password"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent transition"
                placeholder="At least 12 characters"
              />

              {/* Password strength indicator */}
              {showRequirements && password.length > 0 && (
                <div className="mt-3 space-y-2">
                  {/* Strength bar */}
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${strength.color}`}
                        style={{ width: `${(strength.score / 6) * 100}%` }}
                      />
                    </div>
                    <span className={`text-xs font-medium ${
                      strength.score <= 2 ? 'text-red-600' :
                      strength.score <= 4 ? 'text-amber-600' : 'text-green-600'
                    }`}>
                      {strength.label}
                    </span>
                  </div>

                  {/* Requirements checklist */}
                  <div className="grid grid-cols-1 gap-1">
                    <RequirementCheck met={validation.checks.minLength} text="At least 12 characters" />
                    <RequirementCheck met={validation.checks.hasUppercase} text="Uppercase letter (A-Z)" />
                    <RequirementCheck met={validation.checks.hasLowercase} text="Lowercase letter (a-z)" />
                    <RequirementCheck met={validation.checks.hasNumber} text="Number (0-9)" />
                    <RequirementCheck met={validation.checks.hasSpecial} text="Special character (!@#$...)" />
                    <RequirementCheck met={validation.checks.noUsernameParts} text="No username/name parts" />
                  </div>
                </div>
              )}
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
                minLength={12}
                autoComplete="new-password"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent transition"
                placeholder="Re-enter your password"
              />
              {confirmPassword && password !== confirmPassword && (
                <p className="text-xs text-red-500 mt-1">Passwords do not match</p>
              )}
            </div>

            <button
              type="submit"
              disabled={loading || !validation.valid || password !== confirmPassword}
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

function RequirementCheck({ met, text }: { met: boolean; text: string }) {
  return (
    <div className="flex items-center gap-1.5">
      {met ? (
        <svg className="w-3.5 h-3.5 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm0-2a6 6 0 100-12 6 6 0 000 12z" clipRule="evenodd" />
        </svg>
      )}
      <span className={`text-xs ${met ? 'text-green-700' : 'text-gray-500'}`}>{text}</span>
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
