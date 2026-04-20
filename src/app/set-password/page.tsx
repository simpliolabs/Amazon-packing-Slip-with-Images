'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import Image from 'next/image'

function SetPasswordContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)
  const [userName, setUserName] = useState('')
  const [sessionReady, setSessionReady] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    const supabase = createClient()

    async function checkSession() {
      try {
        // With PKCE flow, the /auth/confirm route already verified the token
        // and set the session cookies. We just need to check if we have a session.
        const { data: { session } } = await supabase.auth.getSession()

        if (session?.user) {
          setUserName(session.user.user_metadata?.full_name || session.user.email || '')
          setSessionReady(true)
          setChecking(false)
          return
        }

        // Check for error from /auth/confirm redirect
        const error = searchParams.get('error')
        if (error === 'invite_expired') {
          setErrorMessage('This invite link has expired or was already used. Please ask your admin to send a new invite.')
        } else if (error) {
          setErrorMessage('Authentication failed. Please request a new invite.')
        } else {
          // No session and no error — maybe they navigated here directly
          setErrorMessage('No active session. Please use the invite link sent to you, or ask your admin for a new one.')
        }
      } catch (err) {
        console.error('Session check error:', err)
        setErrorMessage('Something went wrong. Please request a new invite.')
      } finally {
        setChecking(false)
      }
    }

    checkSession()
  }, [searchParams])

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
      const supabase = createClient()

      // Update the user's password
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      })

      if (updateError) {
        toast.error(updateError.message)
        setLoading(false)
        return
      }

      // Create user_profile if it doesn't exist yet via API
      const profileRes = await fetch('/api/auth/setup-profile', { method: 'POST' })
      if (!profileRes.ok) {
        const profileData = await profileRes.json()
        console.error('Profile setup error:', profileData)
      }

      // Clear the invite_token so the invite link stops working
      // The setup-profile API already handles this, but we do it client-side too as a safety net
      try {
        const { data: { user: currentUser } } = await supabase.auth.getUser()
        if (currentUser?.id) {
          await (supabase.from('user_profiles') as any).update({ invite_token: null }).eq('id', currentUser.id)
        }
      } catch { /* ignore — setup-profile API handles this */ }

      toast.success('Password set successfully! Redirecting…')
      router.push('/')
      router.refresh()
    } catch {
      toast.error('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#2E9CE6]"></div>
          <div className="text-sm text-gray-500">Verifying your invite…</div>
        </div>
      </div>
    )
  }

  // No session found — show error with link to login
  if (!sessionReady) {
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
              Invite Link Expired
            </h1>
            <p className="text-sm text-gray-500 mb-6">
              {errorMessage || 'This invite link is no longer valid. Please ask your admin to send a new invite.'}
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
            Welcome{userName ? `, ${userName}` : ''}!
          </h1>
          <p className="text-sm text-gray-500 mb-6">
            Set your password to access the FBM Packing Slip Portal.
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
