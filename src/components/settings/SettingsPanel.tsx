'use client'

import { useState, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  CheckCircle,
  XCircle,
  RefreshCw,
  Info,
  Loader2,
  Save,
  Key,
  ShieldCheck,
  AlertTriangle,
  ExternalLink,
  Tag,
  ChevronRight,
} from 'lucide-react'

interface SettingsPanelProps {
  amazonConnected: boolean
  lastSyncStatus: string
  amazonClientId: string
  amazonClientSecretMasked: string
  amazonRefreshTokenMasked: string
  hasExistingSecret: boolean
  hasExistingToken: boolean
  credentialsRotatedAt: string | null
}

export default function SettingsPanel({
  amazonConnected,
  lastSyncStatus,
  amazonClientId,
  amazonClientSecretMasked,
  amazonRefreshTokenMasked,
  hasExistingSecret,
  hasExistingToken,
  credentialsRotatedAt,
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

  // Credentials form state — secrets are NEVER pre-filled from server
  const [clientId, setClientId] = useState(amazonClientId || '')
  const [clientSecret, setClientSecret] = useState('')
  const [refreshToken, setRefreshToken] = useState('')

  // Track if user wants to update secrets
  const [editingSecret, setEditingSecret] = useState(!hasExistingSecret)
  const [editingToken, setEditingToken] = useState(!hasExistingToken)

  const clientIdChanged = clientId !== (amazonClientId || '')
  const hasNewSecret = editingSecret && clientSecret.trim().length > 0
  const hasNewToken = editingToken && refreshToken.trim().length > 0

  const canSave = clientId.trim() && (
    clientIdChanged ||
    hasNewSecret ||
    hasNewToken
  )

  // API Key rotation status
  const rotationStatus = useMemo(() => {
    if (!credentialsRotatedAt) {
      // No rotation date recorded — assume they need rotation
      return { status: 'unknown' as const, daysOld: null, message: 'Rotation date not recorded' }
    }
    const rotatedAt = new Date(credentialsRotatedAt)
    const daysOld = Math.floor((Date.now() - rotatedAt.getTime()) / (1000 * 60 * 60 * 24))
    
    if (daysOld > 365) {
      return { status: 'expired' as const, daysOld, message: `Credentials are ${daysOld} days old — rotation overdue!` }
    } else if (daysOld > 330) {
      return { status: 'warning' as const, daysOld, message: `Credentials are ${daysOld} days old — rotation due in ${365 - daysOld} days` }
    } else {
      return { status: 'ok' as const, daysOld, message: `Last rotated ${daysOld} days ago` }
    }
  }, [credentialsRotatedAt])

  async function handleSaveCredentials() {
    if (!clientId.trim()) {
      toast.error('Client ID is required')
      return
    }

    // Build payload — only include secrets if user provided new values
    const payload: Record<string, string> = {
      clientId: clientId.trim(),
    }
    if (hasNewSecret) {
      payload.clientSecret = clientSecret.trim()
    }
    if (hasNewToken) {
      payload.refreshToken = refreshToken.trim()
    }

    if (!hasExistingSecret && !hasNewSecret) {
      toast.error('Client Secret is required')
      return
    }
    if (!hasExistingToken && !hasNewToken) {
      toast.error('Refresh Token is required')
      return
    }

    setSavingCreds(true)
    try {
      const res = await fetch('/api/amazon/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        toast.success('Amazon credentials saved — connection is now active')
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
        // Dispatch custom event so OrdersTable re-fetches data
        window.dispatchEvent(new Event('sync-complete'))
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

      {/* API Key Rotation Warning */}
      {amazonConnected && (rotationStatus.status === 'expired' || rotationStatus.status === 'warning') && (
        <div className={`flex items-start gap-3 p-4 rounded-xl mb-5 ${
          rotationStatus.status === 'expired'
            ? 'bg-red-50 border border-red-200'
            : 'bg-amber-50 border border-amber-200'
        }`}>
          <AlertTriangle size={18} className={`flex-shrink-0 mt-0.5 ${
            rotationStatus.status === 'expired' ? 'text-red-600' : 'text-amber-600'
          }`} />
          <div>
            <p className={`text-sm font-medium ${
              rotationStatus.status === 'expired' ? 'text-red-800' : 'text-amber-800'
            }`}>
              {rotationStatus.status === 'expired' ? 'API Key Rotation Overdue' : 'API Key Rotation Due Soon'}
            </p>
            <p className={`text-xs mt-0.5 ${
              rotationStatus.status === 'expired' ? 'text-red-700' : 'text-amber-700'
            }`}>
              {rotationStatus.message}. Amazon Credential Management 1.4 requires API keys to be rotated every 12 months.
            </p>
            {rotationStatus.status === 'expired' && (
              <p className="text-xs text-red-600 mt-1 font-medium">
                Update your credentials below to comply with the rotation policy.
              </p>
            )}
          </div>
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
          {rotationStatus.status === 'ok' && rotationStatus.daysOld !== null && (
            <div className="flex items-center gap-2">
              <ShieldCheck size={12} className="text-green-500 flex-shrink-0" />
              <span>Credential age: <strong>{rotationStatus.daysOld} days</strong> (rotation due at 365)</span>
            </div>
          )}
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

            {/* Client Secret — masked */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Client Secret</label>
              {!editingSecret ? (
                <div className="flex items-center gap-2">
                  <div className="flex-1 px-3 py-2 text-xs border border-gray-200 rounded-lg font-mono bg-gray-50 text-gray-500">
                    {amazonClientSecretMasked}
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingSecret(true)}
                    className="px-3 py-2 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    Update
                  </button>
                </div>
              ) : (
                <div className="space-y-1">
                  <input
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder="Enter new client secret"
                    className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg font-mono bg-white focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent"
                  />
                  {hasExistingSecret && (
                    <button
                      type="button"
                      onClick={() => { setEditingSecret(false); setClientSecret('') }}
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      Cancel — keep existing
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Refresh Token — masked */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Refresh Token <span className="text-gray-400 font-normal">(from Amazon OAuth flow or Seller Central)</span>
              </label>
              {!editingToken ? (
                <div className="flex items-center gap-2">
                  <div className="flex-1 px-3 py-2 text-xs border border-gray-200 rounded-lg font-mono bg-gray-50 text-gray-500">
                    {amazonRefreshTokenMasked}
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingToken(true)}
                    className="px-3 py-2 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    Update
                  </button>
                </div>
              ) : (
                <div className="space-y-1">
                  <input
                    type="password"
                    value={refreshToken}
                    onChange={(e) => setRefreshToken(e.target.value)}
                    placeholder="Enter new refresh token"
                    className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg font-mono bg-white focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent"
                  />
                  {hasExistingToken && (
                    <button
                      type="button"
                      onClick={() => { setEditingToken(false); setRefreshToken('') }}
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      Cancel — keep existing
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={handleSaveCredentials}
              disabled={savingCreds || !canSave}
              className="flex items-center gap-2 px-4 py-2 bg-[#2E9CE6] hover:bg-[#1A7BC4] disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors"
            >
              {savingCreds ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Save size={13} />
              )}
              {savingCreds ? 'Saving…' : 'Save Credentials'}
            </button>
            {amazonConnected && !canSave && (
              <span className="text-xs text-green-600 flex items-center gap-1">
                <ShieldCheck size={12} /> Credentials secured
              </span>
            )}
          </div>

          <p className="mt-3 text-xs text-gray-400 flex items-center gap-1">
            <ShieldCheck size={11} />
            Secrets are never displayed in full. Only masked previews are shown.
          </p>
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

      {/* App Source — Amazon Solution Provider Portal */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-sm font-bold text-gray-900 mb-1">App Source</h2>
            <p className="text-xs text-gray-500">
              This application is registered and managed through the Amazon Solution Provider Portal.
            </p>
          </div>
        </div>

        <a
          href="https://solutionproviderportal.amazon.com/home"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#232F3E] hover:bg-[#37475A] text-white text-xs font-medium rounded-lg transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M21.996 18.23c0 .08-.09.13-.16.09C20.06 17.16 14.53 14.85 12 14.85s-8.06 2.31-9.836 3.47c-.07.04-.164-.01-.164-.09V5.77c0-.08.09-.13.16-.09C3.94 6.84 9.47 9.15 12 9.15s8.06-2.31 9.836-3.47c.07-.04.16.01.16.09v12.46z" fill="#FF9900"/>
          </svg>
          Amazon Solution Provider Portal
          <ExternalLink size={12} />
        </a>

        <div className="mt-3 space-y-1.5 text-xs text-gray-500">
          <p className="flex items-center gap-2">
            <Info size={12} className="text-[#2E9CE6] flex-shrink-0" />
            Manage app permissions, RDT access, and API scopes
          </p>
          <p className="flex items-center gap-2">
            <Info size={12} className="text-[#2E9CE6] flex-shrink-0" />
            View app authorization status and buyer data access
          </p>
        </div>
      </div>

      {/* Blanks catalog (PO 2026-08-22, decision B: lives under Settings). Any signed-in user may
          edit blanks — NOT admin-only like the rest of this page — so it's its own route
          (/settings/blanks) rather than an admin-gated section here; this card just points there. */}
      <Link
        href="/settings/blanks"
        className="flex items-center justify-between bg-white rounded-xl border border-slate-200 p-5 mb-4 hover:border-violet-300 hover:shadow-sm transition-all group">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-violet-50 flex items-center justify-center flex-shrink-0">
            <Tag size={16} className="text-violet-600" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900">Blanks</h2>
            <p className="text-xs text-slate-500">The garment blank catalog — add/correct blanks, no deploy required. Any signed-in user can edit.</p>
          </div>
        </div>
        <ChevronRight size={16} className="text-slate-300 group-hover:text-violet-500 transition-colors flex-shrink-0" />
      </Link>

      {/* FBA Intelligence Settings */}
      <FBASettingsSection />

      {/* Jungle Scout API Settings */}
      <JungleScoutSettingsSection />

      {/* OpenAI API Settings (PR #82) */}
      <OpenAISettingsSection />

      {/* Security Compliance Status */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center gap-2 mb-3">
          <ShieldCheck size={16} className="text-[#2E9CE6]" />
          <h2 className="text-sm font-bold text-gray-900">Security Compliance</h2>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Amazon Credential Management 1.4 compliance status
        </p>

        <div className="space-y-2">
          <ComplianceItem label="Password complexity (12+ chars, mixed)" status="enforced" />
          <ComplianceItem label="Password expiration (365 days max)" status="enforced" />
          <ComplianceItem label="Account lockout (5 failed attempts)" status="enforced" />
          <ComplianceItem label="Multi-factor authentication (TOTP)" status="enforced" />
          <ComplianceItem label="Passwords hashed (bcrypt)" status="enforced" />
          <ComplianceItem label="API key rotation (12 months)" status={
            rotationStatus.status === 'expired' ? 'action_needed' :
            rotationStatus.status === 'warning' ? 'warning' : 'enforced'
          } />
          <ComplianceItem label="Invite link expiration (72 hours)" status="enforced" />
        </div>
      </div>
    </div>
  )
}

function ComplianceItem({ label, status }: { label: string; status: 'enforced' | 'warning' | 'action_needed' }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {status === 'enforced' && <CheckCircle size={13} className="text-green-500 flex-shrink-0" />}
      {status === 'warning' && <AlertTriangle size={13} className="text-amber-500 flex-shrink-0" />}
      {status === 'action_needed' && <XCircle size={13} className="text-red-500 flex-shrink-0" />}
      <span className={
        status === 'enforced' ? 'text-gray-700' :
        status === 'warning' ? 'text-amber-700' : 'text-red-700'
      }>
        {label}
      </span>
    </div>
  )
}

function JungleScoutSettingsSection() {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<{ hasApiKey: boolean; keyName: string; enabled: boolean; apiKeyMasked: string } | null>(null)
  const [editingKey, setEditingKey] = useState(false)
  const [loading, setLoading] = useState(true)

  // Load current status on mount
  useState(() => {
    fetch('/api/jungle-scout/credentials')
      .then(r => r.json())
      .then(data => {
        setStatus(data)
        if (data.keyName) setKeyName(data.keyName)
        setEditingKey(!data.hasApiKey)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  })

  const handleSave = async () => {
    if (!keyName.trim()) { return }
    if (!apiKey.trim() && !status?.hasApiKey) { return }
    setSaving(true)
    try {
      const payload: Record<string, string> = { keyName: keyName.trim() }
      if (apiKey.trim()) payload.apiKey = apiKey.trim()
      else if (status?.hasApiKey) {
        // Re-fetch existing key from DB — not possible without re-entry, require new key
        setSaving(false)
        return
      }
      const resp = await fetch('/api/jungle-scout/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await resp.json()
      if (resp.ok && data.success) {
        toast.success('Jungle Scout API credentials saved — keyword intelligence is now active')
        setSaved(true)
        setApiKey('')
        setEditingKey(false)
        // Refresh status
        const refreshed = await fetch('/api/jungle-scout/credentials').then(r => r.json())
        setStatus(refreshed)
        if (refreshed.keyName) setKeyName(refreshed.keyName)
        setTimeout(() => setSaved(false), 3000)
      } else {
        toast.error(data.error || 'Failed to save credentials')
      }
    } catch {
      toast.error('Network error saving credentials')
    } finally {
      setSaving(false)
    }
  }

  const handleDisable = async () => {
    try {
      await fetch('/api/jungle-scout/credentials', { method: 'DELETE' })
      toast.success('Jungle Scout API disabled')
      const refreshed = await fetch('/api/jungle-scout/credentials').then(r => r.json())
      setStatus(refreshed)
    } catch {
      toast.error('Failed to disable')
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
      <div className="flex items-start justify-between mb-1">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-orange-500" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
          </svg>
          <h2 className="text-sm font-bold text-gray-900">Jungle Scout API</h2>
        </div>
        {!loading && status && (
          <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
            status.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
          }`}>
            {status.enabled ? <><CheckCircle size={12} /> Active</> : <><XCircle size={12} /> Not configured</>}
          </div>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Connect your Jungle Scout API to enable automatic keyword intelligence for listing optimization.
        Requires Growth Accelerator plan + API Tier 1 add-on.
      </p>

      <div className="border border-gray-200 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-4">
          <Key size={14} className="text-gray-500" />
          <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">API Credentials</h3>
        </div>

        <div className="space-y-3">
          {/* Key Name */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Key Name <span className="text-gray-400 font-normal">(from JS Developer page)</span>
            </label>
            <input
              type="text"
              value={keyName}
              onChange={e => setKeyName(e.target.value)}
              placeholder="my-key-name"
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent"
            />
          </div>

          {/* API Key */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              API Key
            </label>
            {!editingKey && status?.hasApiKey ? (
              <div className="flex items-center gap-2">
                <div className="flex-1 px-3 py-2 text-xs border border-gray-200 rounded-lg bg-gray-50 text-gray-500 font-mono">
                  {status.apiKeyMasked}
                </div>
                <button
                  onClick={() => setEditingKey(true)}
                  className="px-3 py-2 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-600 transition-colors"
                >
                  Update
                </button>
              </div>
            ) : (
              <input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="Paste your API key here"
                className="w-full px-3 py-2 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent font-mono"
              />
            )}
            <p className="text-xs text-gray-400 mt-1">
              Get your key from <a href="https://www.junglescout.com/app/settings/developer" target="_blank" rel="noopener noreferrer" className="text-orange-500 hover:underline">Jungle Scout → Settings → Developer</a>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-4">
          <button
            onClick={handleSave}
            disabled={saving || !keyName.trim() || (!apiKey.trim() && !status?.hasApiKey)}
            className="flex items-center gap-2 px-4 py-2 bg-orange-500 text-white text-sm rounded-lg hover:bg-orange-600 disabled:opacity-50 transition-colors"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saved ? 'Saved!' : saving ? 'Saving…' : 'Save Credentials'}
          </button>
          {status?.enabled && (
            <button
              onClick={handleDisable}
              className="px-4 py-2 text-xs border border-red-200 text-red-600 rounded-lg hover:bg-red-50 transition-colors"
            >
              Disable
            </button>
          )}
        </div>
      </div>

      {status?.enabled && (
        <div className="mt-3 flex items-center gap-2 text-xs text-green-700 bg-green-50 rounded-lg p-3">
          <CheckCircle size={13} className="flex-shrink-0" />
          <span>Keyword intelligence is active. AI recommendations will automatically use Jungle Scout data when running audits.</span>
        </div>
      )}
    </div>
  )
}

/**
 * OpenAI API credentials section (PR #82). Mirrors JungleScoutSettingsSection.
 * The pipeline resolves the key DB-first, env-fallback — so an admin can update
 * the key from this UI without redeploying, and historical env-var deploys
 * continue working untouched.
 */
function OpenAISettingsSection() {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<{ hasApiKey: boolean; enabled: boolean; apiKeyMasked: string; envFallbackPresent: boolean } | null>(null)
  const [editingKey, setEditingKey] = useState(false)
  const [loading, setLoading] = useState(true)

  useState(() => {
    fetch('/api/openai/credentials')
      .then(r => r.json())
      .then(data => {
        setStatus(data)
        setEditingKey(!data.hasApiKey)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  })

  const handleSave = async () => {
    if (!apiKey.trim()) return
    setSaving(true)
    try {
      const resp = await fetch('/api/openai/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      })
      const data = await resp.json()
      if (resp.ok && data.success) {
        toast.success('OpenAI API key saved — AI features will use this key on the next request')
        setSaved(true)
        setApiKey('')
        setEditingKey(false)
        const refreshed = await fetch('/api/openai/credentials').then(r => r.json())
        setStatus(refreshed)
        setTimeout(() => setSaved(false), 3000)
      } else {
        toast.error(data.error || 'Failed to save API key')
      }
    } catch {
      toast.error('Network error saving API key')
    } finally {
      setSaving(false)
    }
  }

  const handleDisable = async () => {
    try {
      await fetch('/api/openai/credentials', { method: 'DELETE' })
      toast.success('OpenAI API key disabled')
      const refreshed = await fetch('/api/openai/credentials').then(r => r.json())
      setStatus(refreshed)
    } catch {
      toast.error('Failed to disable')
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
      <div className="flex items-start justify-between mb-1">
        <div className="flex items-center gap-2">
          {/* Simple sparkle / AI mark — kept inline to match the existing icon pattern. */}
          <svg className="w-4 h-4 text-emerald-600" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4L12 2z" />
          </svg>
          <h2 className="text-sm font-bold text-gray-900">OpenAI API</h2>
        </div>
        {!loading && status && (
          <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
            status.enabled || status.envFallbackPresent ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
          }`}>
            {status.enabled
              ? <><CheckCircle size={12} /> Active</>
              : status.envFallbackPresent
                ? <><CheckCircle size={12} /> Active (env)</>
                : <><XCircle size={12} /> Not configured</>}
          </div>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Powers the AI listing optimizer — title / bullets / description agents and the brand-safety judge.
        {status?.envFallbackPresent && !status.hasApiKey && (
          <span className="text-emerald-700"> An <code>OPENAI_API_KEY</code> environment variable is already configured; you can leave this empty or override it here.</span>
        )}
      </p>

      <div className="border border-gray-200 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-4">
          <Key size={14} className="text-gray-500" />
          <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">API Credentials</h3>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              API Key <span className="text-gray-400 font-normal">(starts with sk-)</span>
            </label>
            {!editingKey && status?.hasApiKey ? (
              <div className="flex items-center gap-2">
                <div className="flex-1 px-3 py-2 text-xs border border-gray-200 rounded-lg bg-gray-50 text-gray-500 font-mono">
                  {status.apiKeyMasked}
                </div>
                <button
                  onClick={() => setEditingKey(true)}
                  className="px-3 py-2 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-600 transition-colors"
                >
                  Update
                </button>
              </div>
            ) : (
              <input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full px-3 py-2 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent font-mono"
              />
            )}
            <p className="text-xs text-gray-400 mt-1">
              Get your key from <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:underline">platform.openai.com → API keys</a>.
              Saved keys are never displayed again — only the last 4 chars are shown.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-4">
          <button
            onClick={handleSave}
            disabled={saving || !apiKey.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saved ? 'Saved!' : saving ? 'Saving…' : 'Save Credentials'}
          </button>
          {status?.enabled && (
            <button
              onClick={handleDisable}
              className="px-4 py-2 text-xs border border-red-200 text-red-600 rounded-lg hover:bg-red-50 transition-colors"
            >
              Disable
            </button>
          )}
        </div>
      </div>

      {status?.enabled && (
        <div className="mt-3 flex items-center gap-2 text-xs text-green-700 bg-green-50 rounded-lg p-3">
          <CheckCircle size={13} className="flex-shrink-0" />
          <span>OpenAI API key active. Brand-safety judge, title/bullet/description agents will use this key for all regens going forward.</span>
        </div>
      )}
    </div>
  )
}

function FBASettingsSection() {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [leadTime, setLeadTime] = useState('14')
  const [safetyBuffer, setSafetyBuffer] = useState('15')
  const [triggerWeeks, setTriggerWeeks] = useState('4')
  const [minUnits, setMinUnits] = useState('5')
  const [loaded, setLoaded] = useState(false)

  // Load current settings on mount
  useState(() => {
    if (loaded) return
    fetch('/api/fba/settings')
      .then(r => r.json())
      .then(data => {
        if (data.leadTimeDays) setLeadTime(String(data.leadTimeDays))
        if (data.safetyBufferDays) setSafetyBuffer(String(data.safetyBufferDays))
        if (data.replenishTriggerWeeks) setTriggerWeeks(String(data.replenishTriggerWeeks))
        if (data.newFBACandidateMinUnits) setMinUnits(String(data.newFBACandidateMinUnits))
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  })

  const handleSave = async () => {
    setSaving(true)
    try {
      const resp = await fetch('/api/fba/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadTimeDays: parseInt(leadTime, 10),
          safetyBufferDays: parseInt(safetyBuffer, 10),
          replenishTriggerWeeks: parseFloat(triggerWeeks),
          newFBACandidateMinUnits: parseInt(minUnits, 10),
        }),
      })
      if (resp.ok) {
        setSaved(true)
        toast.success('FBA settings saved')
        setTimeout(() => setSaved(false), 3000)
      } else {
        toast.error('Failed to save FBA settings')
      }
    } catch {
      toast.error('Failed to save FBA settings')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
      <div className="flex items-center gap-2 mb-1">
        <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
        <h2 className="text-sm font-bold text-gray-900">FBA Intelligence</h2>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Configure replenishment thresholds for the FBA Intelligence dashboard.
      </p>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Lead Time (days)
          </label>
          <input
            type="number"
            min="1"
            max="60"
            value={leadTime}
            onChange={e => setLeadTime(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-gray-400 mt-1">Days from ship to FBA check-in</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Safety Buffer (days)
          </label>
          <input
            type="number"
            min="1"
            max="60"
            value={safetyBuffer}
            onChange={e => setSafetyBuffer(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-gray-400 mt-1">Extra days of stock after lead time</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Replenish Trigger (weeks of cover)
          </label>
          <input
            type="number"
            min="1"
            max="12"
            step="0.5"
            value={triggerWeeks}
            onChange={e => setTriggerWeeks(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-gray-400 mt-1">Send when FBA drops below this threshold</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            New FBA Candidate (min units/month)
          </label>
          <input
            type="number"
            min="1"
            max="100"
            value={minUnits}
            onChange={e => setMinUnits(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-gray-400 mt-1">Minimum FBM sales to recommend FBA listing</p>
        </div>
      </div>

      <div className="mt-4 p-3 bg-blue-50 rounded-lg text-xs text-blue-700">
        <strong>Send Qty Formula:</strong> (velocity/day × lead time) + (velocity/day × safety buffer) − current FBA stock
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="mt-4 flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        {saved ? 'Saved!' : saving ? 'Saving…' : 'Save FBA Settings'}
      </button>
    </div>
  )
}
