'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import {
  CheckCircle,
  XCircle,
  RefreshCw,
  AlertTriangle,
  Info,
  Loader2,
  Save,
  Eye,
  EyeOff,
  Key,
} from 'lucide-react'

interface SettingsPanelProps {
  amazonConnected: boolean
  lastSyncStatus: string
  amazonClientId: string
  amazonClientSecret: string
  amazonRefreshToken: string
}

export default function SettingsPanel({
  amazonConnected,
  lastSyncStatus,
  amazonClientId,
  amazonClientSecret,
  amazonRefreshToken,
}: SettingsPanelProps) {
  const searchParams = useSearchParams()
  const successParam = searchParams.get('success')
  const errorParam = searchParams.get('error')

  const [syncing, setSyncing] = useState(false)
  const [savingCreds, setSavingCreds] = useState(false)
  const [syncResult, setSyncResult] = useState<{
    success: boolean
    ordersInserted?: number
    error?: string
  } | null>(null)

  // Credentials form state
  const [clientId, setClientId] = useState(amazonClientId || '')
  const [clientSecret, setClientSecret] = useState(amazonClientSecret || '')
  const [refreshToken, setRefreshToken] = useState(amazonRefreshToken || '')
  const [showSecret, setShowSecret] = useState(false)
  const [showToken, setShowToken] = useState(false)

  const credentialsChanged =
    clientId !== (amazonClientId || '') ||
    clientSecret !== (amazonClientSecret || '') ||
    refreshToken !== (amazonRefreshToken || '')

  const credentialsFilled = clientId.trim() && clientSecret.trim() && refreshToken.trim()

  async function handleSaveCredentials() {
    if (!credentialsFilled) {
      toast.error('Please fill in all three credential fields')
      return
    }
    setSavingCreds(true)
    try {
      const res = await fetch('/api/amazon/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          refreshToken: refreshToken.trim(),
        }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        toast.success('Amazon credentials saved — connection is now active')
        // Reload to update connected status
        window.location.reload()
      } else {
        toast.error(data.error || 'Failed to save credentials')
      }
    } catch {
      toast.error('Network error saving credentials')
    } finally {
      setSavingCreds(false)
    }
  }

  async function handleManualSync() {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/sync', { method: 'POST' })
      const data = await res.json()
      setSyncResult(data)
      if (data.success) {
        toast.success(`Sync complete — ${data.ordersInserted} orders updated`)
      } else {
        toast.error(data.error || 'Sync failed')
      }
    } catch {
      toast.error('Sync request failed')
      setSyncResult({ success: false, error: 'Network error' })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="p-4 lg:p-6 max-w-2xl">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-0.5">Configure your Amazon integration and app preferences</p>
      </div>

      {/* Success/Error banners from OAuth redirect */}
      {successParam === 'amazon_connected' && (
        <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-xl mb-5">
          <CheckCircle size={18} className="text-green-600 flex-shrink-0" />
          <p className="text-sm text-green-800 font-medium">Amazon account connected successfully!</p>
        </div>
      )}
      {errorParam && (
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl mb-5">
          <XCircle size={18} className="text-red-600 flex-shrink-0" />
          <p className="text-sm text-red-800">Connection error: {decodeURIComponent(errorParam)}</p>
        </div>
      )}

      {/* Amazon Connection Status */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-sm font-bold text-gray-900 mb-1">Amazon SP-API Connection</h2>
            <p className="text-xs text-gray-500">
              Connect your Amazon Seller Central account to enable automatic order syncing.
            </p>
          </div>
          <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
            amazonConnected
              ? 'bg-green-100 text-green-700'
              : 'bg-gray-100 text-gray-600'
          }`}>
            {amazonConnected ? (
              <><CheckCircle size={12} /> Connected</>
            ) : (
              <><XCircle size={12} /> Not Connected</>
            )}
          </div>
        </div>

        <div className="space-y-3 text-xs text-gray-600 bg-gray-50 rounded-lg p-3 mb-5">
          <div className="flex items-center gap-2">
            <Info size={12} className="text-[#2E9CE6] flex-shrink-0" />
            <span>Marketplace: <strong>US (ATVPDKIKX0DER)</strong></span>
          </div>
          <div className="flex items-center gap-2">
            <Info size={12} className="text-[#2E9CE6] flex-shrink-0" />
            <span>Merchant Token: <strong>A9YU5DSRQQWDU</strong></span>
          </div>
          <div className="flex items-center gap-2">
            <Info size={12} className="text-[#2E9CE6] flex-shrink-0" />
            <span>Sync frequency: <strong>Every 30 minutes (automatic)</strong></span>
          </div>
          <div className="flex items-center gap-2">
            <Info size={12} className="text-[#2E9CE6] flex-shrink-0" />
            <span>Data retention: <strong>7 days</strong></span>
          </div>
        </div>

        {/* Credentials Form */}
        <div className="border border-gray-200 rounded-lg p-4 mb-4">
          <div className="flex items-center gap-2 mb-4">
            <Key size={14} className="text-gray-500" />
            <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
              Amazon Developer Credentials
            </h3>
          </div>

          <div className="space-y-3">
            {/* Client ID */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Client ID <span className="text-gray-400 font-normal">(from Amazon Developer Central)</span>
              </label>
              <input
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="amzn1.application-oa2-client.xxxxxxxx"
                className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg font-mono bg-white focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent"
              />
            </div>

            {/* Client Secret */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Client Secret
              </label>
              <div className="relative">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="amzn1.oa2-cs.v1.xxxxxxxx"
                  className="w-full px-3 py-2 pr-9 text-xs border border-gray-200 rounded-lg font-mono bg-white focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>

            {/* Refresh Token */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Refresh Token <span className="text-gray-400 font-normal">(from Amazon OAuth flow or Seller Central)</span>
              </label>
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={refreshToken}
                  onChange={(e) => setRefreshToken(e.target.value)}
                  placeholder="Atzr|xxxxxxxx"
                  className="w-full px-3 py-2 pr-9 text-xs border border-gray-200 rounded-lg font-mono bg-white focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={handleSaveCredentials}
              disabled={savingCreds || !credentialsFilled}
              className="flex items-center gap-2 px-4 py-2 bg-[#2E9CE6] hover:bg-[#1A7BC4] disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors"
            >
              {savingCreds ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Save size={13} />
              )}
              {savingCreds ? 'Saving…' : 'Save Credentials'}
            </button>
            {credentialsChanged && !savingCreds && (
              <span className="text-xs text-amber-600 flex items-center gap-1">
                <AlertTriangle size={12} /> Unsaved changes
              </span>
            )}
            {amazonConnected && !credentialsChanged && (
              <span className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle size={12} /> Credentials saved
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Manual Sync */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <h2 className="text-sm font-bold text-gray-900 mb-1">Manual Sync</h2>
        <p className="text-xs text-gray-500 mb-4">
          Trigger an immediate sync of FBM orders from the last 7 days.
          Automatic sync runs every 30 minutes in the background.
        </p>

        {syncResult && (
          <div className={`flex items-center gap-2 p-3 rounded-lg mb-4 text-sm ${
            syncResult.success
              ? 'bg-green-50 border border-green-200 text-green-800'
              : 'bg-red-50 border border-red-200 text-red-800'
          }`}>
            {syncResult.success ? (
              <><CheckCircle size={14} /> Synced {syncResult.ordersInserted} orders successfully</>
            ) : (
              <><XCircle size={14} /> {syncResult.error || 'Sync failed'}</>
            )}
          </div>
        )}

        <button
          onClick={handleManualSync}
          disabled={syncing || !amazonConnected}
          className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {syncing ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          {syncing ? 'Syncing orders…' : 'Sync Now'}
        </button>

        {!amazonConnected && (
          <p className="text-xs text-gray-400 mt-2">Save your Amazon credentials above to enable syncing.</p>
        )}
      </div>
    </div>
  )
}
