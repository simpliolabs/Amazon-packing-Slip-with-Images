'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import Image from 'next/image'

function SetPasswordContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [inviteToken, setInviteToken] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    const token = searchParams.get('token')
    const error = searchParams.get('error')

    if (error === 'invite_expired') {
      setErrorMessage('This invite link has expired or was already used. Please ask your admin to send a new invite.')
    } else if (error === 'invalid_link') {
      setErrorMessage('This invite link is invalid. Please ask your admin to send a new invite.')
    } else if (error) {
      setErrorMessage('Something went wrong. Please ask your admin to send a new invite.')
    } else if (!token) {
      setErrorMessage('No invite token found. Please use the invite link sent to you.')
    } else {
      setInviteToken(token)
    }
  }, [searchParams])

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault()

    if (!inviteToken) {
      toast.error('No invite token. Please use the invite link sent to you.')
      return
    }

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
      const res = await fetch('/api/auth/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: inviteToken, password }),
      })

      const data = await res.json()

      if (!res.ok) {
        toast.error(data.error || 'Failed to set password')
        setLoading(false)
        return
      }

      toast.success('Password set successfully! Redirecting to login…')

      // Redirect to login page — user will log in with their new password
      setTimeout(() => {
        router.push('/login')
      }, 1500)
    } catch {
      toast.error('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  // Show error state
  if (errorMessage) {
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
              {errorMessage}
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

  // Show password form
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
