'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import {
  CheckCircle,
  XCircle,
  Link,
  RefreshCw,
  AlertTriangle,
  Info,
  Loader2,
} from 'lucide-react'

interface SettingsPanelProps {
  amazonConnected: boolean
  lastSyncStatus: string
}

export default function SettingsPanel({
  amazonConnected,
  lastSyncStatus,
}: SettingsPanelProps) {
  const searchParams = useSearchParams()
  const successParam = searchParams.get('success')
  const errorParam = searchParams.get('error')

  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{
    success: boolean
    ordersInserted?: number
    error?: string
  } | null>(null)

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

      {/* Amazon Connection */}
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

        <div className="space-y-3 text-xs text-gray-600 bg-gray-50 rounded-lg p-3 mb-4">
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

        {!amazonConnected && (
          <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg mb-4">
            <AlertTriangle size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800">
              Amazon Developer account approval is pending. Once approved, add your
              <strong> AMAZON_CLIENT_ID</strong>, <strong>AMAZON_CLIENT_SECRET</strong>, and
              <strong> AMAZON_REFRESH_TOKEN</strong> to your <code>.env.local</code> file,
              then click "Connect Amazon" below.
            </p>
          </div>
        )}

        <a
          href="/api/amazon/connect"
          className="inline-flex items-center gap-2 px-4 py-2 bg-[#2E9CE6] hover:bg-[#1A7BC4] text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Link size={14} />
          {amazonConnected ? 'Reconnect Amazon' : 'Connect Amazon'}
        </a>
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
          <p className="text-xs text-gray-400 mt-2">Connect Amazon first to enable syncing.</p>
        )}
      </div>

      {/* Environment Variables Reference */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-bold text-gray-900 mb-3">Required Environment Variables</h2>
        <div className="space-y-2">
          {[
            { key: 'NEXT_PUBLIC_SUPABASE_URL', status: 'set', desc: 'Supabase project URL' },
            { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', status: 'set', desc: 'Supabase public key' },
            { key: 'SUPABASE_SERVICE_ROLE_KEY', status: 'required', desc: 'Supabase service role key (from Project Settings → API)' },
            { key: 'AMAZON_CLIENT_ID', status: 'pending', desc: 'Amazon SP-API Client ID (after developer approval)' },
            { key: 'AMAZON_CLIENT_SECRET', status: 'pending', desc: 'Amazon SP-API Client Secret' },
            { key: 'AMAZON_REFRESH_TOKEN', status: 'pending', desc: 'Amazon refresh token (after OAuth flow)' },
            { key: 'CRON_SECRET', status: 'required', desc: 'Random secret for cron job authentication' },
          ].map((env) => (
            <div key={env.key} className="flex items-center gap-3 text-xs">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                env.status === 'set' ? 'bg-green-500' :
                env.status === 'pending' ? 'bg-amber-400' : 'bg-red-400'
              }`} />
              <code className="font-mono text-gray-800 font-medium">{env.key}</code>
              <span className="text-gray-400">— {env.desc}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-3">
          See <code>.env.example</code> in the project root for the full template.
        </p>
      </div>
    </div>
  )
}
