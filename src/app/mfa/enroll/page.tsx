'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import Image from 'next/image'

export default function MFAEnrollPage() {
  const router = useRouter()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [enrolling, setEnrolling] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [verifyCode, setVerifyCode] = useState('')
  const [step, setStep] = useState<'intro' | 'scan' | 'verify' | 'done'>('intro')
  const [userEmail, setUserEmail] = useState<string | null>(null)

  useEffect(() => {
    async function checkAuth() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }
      setUserEmail(user.email || null)

      // Check if already enrolled
      const { data: factors } = await supabase.auth.mfa.listFactors()
      const verifiedTOTP = factors?.totp?.filter(f => f.status === 'verified') || []
      if (verifiedTOTP.length > 0) {
        setStep('done')
      }
      setLoading(false)
    }
    checkAuth()
  }, [supabase.auth, router])

  async function handleStartEnroll() {
    setEnrolling(true)
    try {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Authenticator App',
      })

      if (error) {
        toast.error(error.message)
        setEnrolling(false)
        return
      }

      setQrCode(data.totp.qr_code)
      setSecret(data.totp.secret)
      setFactorId(data.id)
      setStep('scan')
    } catch {
      toast.error('Failed to start MFA enrollment')
    }
    setEnrolling(false)
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    if (!factorId || verifyCode.length !== 6) return

    setVerifying(true)
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId,
      })

      if (challengeError) {
        toast.error(challengeError.message)
        setVerifying(false)
        return
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: verifyCode,
      })

      if (verifyError) {
        toast.error('Invalid code. Please try again.')
        setVerifyCode('')
        setVerifying(false)
        return
      }

      // Mark MFA as enrolled in user_profiles
      try {
        await fetch('/api/auth/mfa-enrolled', { method: 'POST' })
      } catch {
        // Non-critical
      }

      toast.success('MFA enabled successfully!')
      setStep('done')
    } catch {
      toast.error('Verification failed. Please try again.')
    }
    setVerifying(false)
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#2E9CE6]"></div>
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
          {step === 'intro' && (
            <>
              <div className="text-center mb-6">
                <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-8 h-8 text-[#2E9CE6]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <h1 className="text-2xl font-bold text-gray-900 mb-2">
                  Set Up Two-Factor Authentication
                </h1>
                <p className="text-sm text-gray-500">
                  MFA is required for all accounts handling Amazon data.
                  You&apos;ll need an authenticator app like Google Authenticator, Authy, or 1Password.
                </p>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
                <p className="text-sm text-amber-800">
                  <strong>Required:</strong> Amazon Credential Management 1.4 requires MFA on all accounts with access to order data.
                </p>
              </div>

              <div className="space-y-3 mb-6">
                <h3 className="text-sm font-semibold text-gray-700">Recommended authenticator apps:</h3>
                <ul className="text-sm text-gray-600 space-y-1.5">
                  <li className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 bg-[#2E9CE6] rounded-full"></span>
                    Google Authenticator (iOS / Android)
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 bg-[#2E9CE6] rounded-full"></span>
                    Authy (iOS / Android / Desktop)
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 bg-[#2E9CE6] rounded-full"></span>
                    1Password (built-in TOTP support)
                  </li>
                </ul>
              </div>

              <button
                onClick={handleStartEnroll}
                disabled={enrolling}
                className="w-full py-2.5 px-4 bg-[#2E9CE6] hover:bg-[#1A7BC4] disabled:opacity-60 text-white font-semibold rounded-lg text-sm transition-colors"
              >
                {enrolling ? 'Setting up…' : 'Begin Setup'}
              </button>
            </>
          )}

          {step === 'scan' && (
            <>
              <h1 className="text-xl font-bold text-gray-900 mb-2">
                Scan QR Code
              </h1>
              <p className="text-sm text-gray-500 mb-6">
                Open your authenticator app and scan this QR code to add your account.
              </p>

              {qrCode && (
                <div className="flex justify-center mb-4">
                  <img src={qrCode} alt="MFA QR Code" className="w-48 h-48 rounded-lg border border-gray-200" />
                </div>
              )}

              {secret && (
                <div className="bg-gray-50 rounded-lg p-3 mb-6">
                  <p className="text-xs text-gray-500 mb-1">Can&apos;t scan? Enter this code manually:</p>
                  <code className="text-xs font-mono text-gray-700 break-all select-all">{secret}</code>
                </div>
              )}

              <button
                onClick={() => setStep('verify')}
                className="w-full py-2.5 px-4 bg-[#2E9CE6] hover:bg-[#1A7BC4] text-white font-semibold rounded-lg text-sm transition-colors"
              >
                I&apos;ve Scanned the Code
              </button>
            </>
          )}

          {step === 'verify' && (
            <>
              <h1 className="text-xl font-bold text-gray-900 mb-2">
                Verify Setup
              </h1>
              <p className="text-sm text-gray-500 mb-6">
                Enter the 6-digit code from your authenticator app to confirm setup.
              </p>

              <form onSubmit={handleVerify} className="space-y-4">
                <div>
                  <label htmlFor="code" className="block text-sm font-medium text-gray-700 mb-1">
                    Verification Code
                  </label>
                  <input
                    id="code"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                    required
                    autoFocus
                    autoComplete="one-time-code"
                    className="w-full px-3 py-3 border border-gray-300 rounded-lg text-center text-2xl font-mono tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent transition"
                    placeholder="000000"
                  />
                </div>

                <button
                  type="submit"
                  disabled={verifying || verifyCode.length !== 6}
                  className="w-full py-2.5 px-4 bg-[#2E9CE6] hover:bg-[#1A7BC4] disabled:opacity-60 text-white font-semibold rounded-lg text-sm transition-colors"
                >
                  {verifying ? 'Verifying…' : 'Verify & Enable MFA'}
                </button>
              </form>

              <button
                onClick={() => setStep('scan')}
                className="w-full mt-3 py-2 text-sm text-gray-500 hover:text-gray-700"
              >
                ← Back to QR Code
              </button>
            </>
          )}

          {step === 'done' && (
            <>
              <div className="text-center">
                <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h1 className="text-xl font-bold text-gray-900 mb-2">
                  MFA Enabled
                </h1>
                <p className="text-sm text-gray-500 mb-6">
                  Two-factor authentication is active on your account. You&apos;ll be asked for a code each time you sign in.
                </p>
                <button
                  onClick={() => router.push('/')}
                  className="w-full py-2.5 px-4 bg-[#2E9CE6] hover:bg-[#1A7BC4] text-white font-semibold rounded-lg text-sm transition-colors"
                >
                  Continue to Dashboard
                </button>
              </div>
            </>
          )}
        </div>

        {userEmail && (
          <p className="text-center text-xs text-gray-400 mt-4">
            Signed in as {userEmail}
          </p>
        )}
      </div>
    </div>
  )
}
