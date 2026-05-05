'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import Image from 'next/image'

export default function MFAVerifyPage() {
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [verifying, setVerifying] = useState(false)
  const [code, setCode] = useState('')
  const [factorId, setFactorId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [debugInfo, setDebugInfo] = useState<string>('')

  useEffect(() => {
    async function checkFactors() {
      try {
        const supabase = createClient()

        // Step 1: Check if user has any session at all
        const { data: { session }, error: sessionError } = await supabase.auth.getSession()

        if (sessionError) {
          setDebugInfo(`Session error: ${sessionError.message}`)
          setLoading(false)
          return
        }

        if (!session) {
          // No session — redirect to login
          router.push('/login')
          return
        }

        // Step 2: Check AAL level
        const { data: aalData, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()

        if (aalError) {
          setDebugInfo(`AAL error: ${aalError.message}`)
          setLoading(false)
          return
        }

        const currentLevel = aalData?.currentLevel
        const nextLevel = aalData?.nextLevel

        // If already at AAL2, redirect to dashboard
        if (currentLevel === 'aal2') {
          router.push('/')
          return
        }

        // Step 3: List factors — works with AAL1 session
        const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors()

        if (factorsError) {
          setDebugInfo(`Factors error: ${factorsError.message} | AAL: ${currentLevel} → ${nextLevel}`)
          setLoading(false)
          return
        }

        const totpFactors = factors?.totp || []
        const verifiedFactors = totpFactors.filter(f => f.status === 'verified')

        if (verifiedFactors.length === 0) {
          // No verified MFA — redirect to enroll
          router.push('/mfa/enroll')
          return
        }

        setFactorId(verifiedFactors[0].id)
        setLoading(false)
      } catch (err) {
        setDebugInfo(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`)
        setLoading(false)
      }
    }

    checkFactors()
  }, [router])

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    if (!factorId || code.length !== 6) return

    setVerifying(true)
    setError(null)

    try {
      const supabase = createClient()

      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId,
      })

      if (challengeError) {
        setError(challengeError.message)
        setVerifying(false)
        return
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code,
      })

      if (verifyError) {
        setError('Invalid code. Please check your authenticator app and try again.')
        setCode('')
        setVerifying(false)
        return
      }

      // MFA verified — redirect to dashboard
      toast.success('Verified successfully')
      router.push('/')
      router.refresh()
    } catch (err) {
      setError(`Verification failed: ${err instanceof Error ? err.message : 'Please try again.'}`)
    }
    setVerifying(false)
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#2E9CE6]"></div>
          <p className="text-xs text-gray-400">Loading security check…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <Image src="/logo.png" alt="TheCEO.Store" width={200} height={90} className="object-contain" priority />
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <div className="text-center mb-6">
            <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-[#2E9CE6]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">
              Two-Factor Authentication
            </h1>
            <p className="text-sm text-gray-500">
              Enter the 6-digit code from your authenticator app to continue.
            </p>
          </div>

          {debugInfo && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
              <p className="text-xs text-yellow-800 font-mono">{debugInfo}</p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {factorId ? (
            <form onSubmit={handleVerify} className="space-y-4">
              <div>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  required
                  autoFocus
                  autoComplete="one-time-code"
                  className="w-full px-3 py-3 border border-gray-300 rounded-lg text-center text-2xl font-mono tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent transition"
                  placeholder="000000"
                />
              </div>

              <button
                type="submit"
                disabled={verifying || code.length !== 6}
                className="w-full py-2.5 px-4 bg-[#2E9CE6] hover:bg-[#1A7BC4] disabled:opacity-60 text-white font-semibold rounded-lg text-sm transition-colors"
              >
                {verifying ? 'Verifying…' : 'Verify'}
              </button>
            </form>
          ) : (
            <div className="text-center py-4">
              <p className="text-sm text-gray-500">No MFA factors found. Please contact your administrator.</p>
              <button
                onClick={() => router.push('/login')}
                className="mt-3 text-sm text-[#2E9CE6] hover:underline"
              >
                Back to Login
              </button>
            </div>
          )}

          <div className="mt-6 pt-4 border-t border-gray-100">
            <p className="text-xs text-gray-400 text-center">
              Lost access to your authenticator? Contact your administrator.
            </p>
          </div>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          FBM Packing Slip Portal — Security Verification
        </p>
      </div>
    </div>
  )
}
