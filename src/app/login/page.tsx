'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import Image from 'next/image'

import { Suspense } from 'react'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirectTo = searchParams.get('redirectTo') || '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [locked, setLocked] = useState(false)
  const [lockoutMinutes, setLockoutMinutes] = useState(0)
  const [remainingAttempts, setRemainingAttempts] = useState<number | null>(null)

  const supabase = createClient()

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    if (locked) return
    setLoading(true)

    try {
      // Use server-side login API for lockout tracking
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })

      const data = await res.json()

      if (!res.ok) {
        if (data.locked) {
          setLocked(true)
          setLockoutMinutes(data.lockoutMinutes || 30)
          toast.error(`Account locked. Try again in ${data.lockoutMinutes || 30} minutes.`)
        } else {
          toast.error(data.error || 'Invalid credentials')
          if (data.remainingAttempts !== undefined) {
            setRemainingAttempts(data.remainingAttempts)
          }
        }
        setLoading(false)
        return
      }

      // Server-side login succeeded — now we need to also sign in client-side
      // to set the browser cookies properly
      const { error: clientError } = await supabase.auth.signInWithPassword({ email, password })

      if (clientError) {
        // Server accepted but client failed — unusual, try to proceed anyway
        console.warn('Client-side sign-in failed after server success:', clientError)
      }

      toast.success('Signed in successfully')

      // Check if MFA verification is needed
      if (data.mfaRequired) {
        router.push('/mfa/verify')
      } else if (!data.mfaEnrolled) {
        // No MFA enrolled — redirect to enrollment (required by policy)
        router.push('/mfa/enroll')
      } else if (data.passwordExpired) {
        router.push('/reset-password?reason=expired')
      } else {
        router.push(redirectTo)
      }
      router.refresh()
    } catch {
      toast.error('Network error. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Sign in</h1>
      <p className="text-sm text-gray-500 mb-6">
        FBM Packing Slip Portal — Internal Use Only
      </p>

      {locked && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
          <p className="text-sm text-red-700 font-medium">Account Temporarily Locked</p>
          <p className="text-xs text-red-600 mt-1">
            Too many failed login attempts. Please try again in {lockoutMinutes} minutes.
          </p>
        </div>
      )}

      {remainingAttempts !== null && remainingAttempts <= 2 && !locked && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
          <p className="text-xs text-amber-700">
            Warning: {remainingAttempts} attempt{remainingAttempts !== 1 ? 's' : ''} remaining before account lockout.
          </p>
        </div>
      )}

      <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                disabled={locked}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent transition disabled:opacity-50 disabled:bg-gray-50"
                placeholder="you@theceo.store"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                disabled={locked}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent transition disabled:opacity-50 disabled:bg-gray-50"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={loading || locked}
              className="w-full py-2.5 px-4 bg-[#2E9CE6] hover:bg-[#1A7BC4] disabled:opacity-60 text-white font-semibold rounded-lg text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:ring-offset-2"
            >
              {loading ? 'Signing in…' : locked ? 'Account Locked' : 'Sign in'}
            </button>
      </form>
    </div>
  )
}

export default function LoginPage() {
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

        {/* Card with Suspense */}
        <Suspense fallback={
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center text-sm text-gray-500">
            Loading…
          </div>
        }>
          <LoginForm />
        </Suspense>

        <p className="text-center text-xs text-gray-400 mt-6">
          Access restricted to authorized personnel only.
        </p>
      </div>
    </div>
  )
}
