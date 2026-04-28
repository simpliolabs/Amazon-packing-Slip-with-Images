'use client'

import { useState, useEffect, useMemo, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { validatePassword, getPasswordStrength } from '@/lib/auth/passwordValidator'

function ResetPasswordContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const reason = searchParams.get('reason')

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [fullName, setFullName] = useState<string | null>(null)

  const supabase = createClient()

  const validation = useMemo(
    () => validatePassword(password, userEmail, fullName),
    [password, userEmail, fullName]
  )
  const strength = useMemo(
    () => getPasswordStrength(validation.checks),
    [validation.checks]
  )

  useEffect(() => {
    async function checkAuth() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }
      setUserEmail(user.email || null)
      setFullName(user.user_metadata?.full_name || null)
    }
    checkAuth()
  }, [supabase.auth, router])

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault()

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
      const { error } = await supabase.auth.updateUser({ password })

      if (error) {
        toast.error(error.message || 'Failed to update password')
        setLoading(false)
        return
      }

      // Update password_changed_at
      await fetch('/api/auth/setup-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passwordChanged: true }),
      })

      toast.success('Password updated successfully!')
      setTimeout(() => router.push('/'), 1500)
    } catch {
      toast.error('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-8">
          <Image src="/logo.png" alt="TheCEO.Store" width={200} height={90} className="object-contain" priority />
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          {reason === 'expired' && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
              <p className="text-sm text-amber-800 font-medium">Password Expired</p>
              <p className="text-xs text-amber-700 mt-1">
                Your password is over 365 days old. Per Amazon Credential Management 1.4 policy, you must set a new password to continue.
              </p>
            </div>
          )}

          <h1 className="text-2xl font-bold text-gray-900 mb-1">
            {reason === 'expired' ? 'Update Your Password' : 'Reset Password'}
          </h1>
          <p className="text-sm text-gray-500 mb-6">
            Choose a new password that meets security requirements.
          </p>

          <form onSubmit={handleResetPassword} className="space-y-4">
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                New Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={12}
                autoComplete="new-password"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent transition"
                placeholder="At least 12 characters"
              />

              {password.length > 0 && (
                <div className="mt-3 space-y-2">
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

                  <div className="grid grid-cols-1 gap-1">
                    <Check met={validation.checks.minLength} text="At least 12 characters" />
                    <Check met={validation.checks.hasUppercase} text="Uppercase letter (A-Z)" />
                    <Check met={validation.checks.hasLowercase} text="Lowercase letter (a-z)" />
                    <Check met={validation.checks.hasNumber} text="Number (0-9)" />
                    <Check met={validation.checks.hasSpecial} text="Special character (!@#$...)" />
                    <Check met={validation.checks.noUsernameParts} text="No username/name parts" />
                  </div>
                </div>
              )}
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
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
              className="w-full py-2.5 px-4 bg-[#2E9CE6] hover:bg-[#1A7BC4] disabled:opacity-60 text-white font-semibold rounded-lg text-sm transition-colors"
            >
              {loading ? 'Updating…' : 'Update Password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

function Check({ met, text }: { met: boolean; text: string }) {
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#2E9CE6]"></div>
      </div>
    }>
      <ResetPasswordContent />
    </Suspense>
  )
}
