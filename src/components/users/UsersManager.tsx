'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { UserPlus, Trash2, Shield, User, Loader2, Link2, RefreshCw, Clock, Copy, Check, X } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import type { UserProfile } from '@/types/database'

interface UserWithStatus extends UserProfile {
  status: 'active' | 'pending'
}

export default function UsersManager() {
  const [users, setUsers] = useState<UserWithStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [showInviteForm, setShowInviteForm] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'packer' | 'admin'>('packer')
  const [inviteName, setInviteName] = useState('')
  const [inviting, setInviting] = useState(false)
  const [reinviting, setReinviting] = useState<string | null>(null)
  const [generatedLink, setGeneratedLink] = useState<string | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/users')
      const data = await res.json()
      if (data.users) setUsers(data.users)
    } catch {
      toast.error('Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setInviting(true)
    setGeneratedLink(null)
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: inviteEmail,
          role: inviteRole,
          fullName: inviteName,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setGeneratedLink(data.inviteLink)
      toast.success('Invite link generated! Copy and share it.')
      fetchUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate invite link')
    } finally {
      setInviting(false)
    }
  }

  async function handleReinvite(userId: string, email: string, fullName: string, role: string) {
    setReinviting(userId)
    setGeneratedLink(null)
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          role,
          fullName,
          reinvite: true,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setGeneratedLink(data.inviteLink)
      toast.success('New invite link generated! Copy and share it.')
      fetchUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate reinvite link')
    } finally {
      setReinviting(null)
    }
  }

  async function copyLink() {
    if (!generatedLink) return
    try {
      await navigator.clipboard.writeText(generatedLink)
      setLinkCopied(true)
      toast.success('Link copied to clipboard!')
      setTimeout(() => setLinkCopied(false), 3000)
    } catch {
      // Fallback: select the text in the input
      toast.error('Failed to copy — please select and copy manually')
    }
  }

  function dismissLink() {
    setGeneratedLink(null)
    setLinkCopied(false)
    setInviteEmail('')
    setInviteName('')
    setInviteRole('packer')
    setShowInviteForm(false)
  }

  async function handleRoleChange(userId: string, newRole: 'admin' | 'packer') {
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      })
      if (!res.ok) throw new Error('Failed to update role')
      toast.success('Role updated')
      fetchUsers()
    } catch {
      toast.error('Failed to update role')
    }
  }

  async function handleDelete(userId: string, email: string) {
    if (!confirm(`Remove ${email} from the portal?`)) return
    try {
      const res = await fetch(`/api/users/${userId}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error)
      }
      toast.success('User removed')
      fetchUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove user')
    }
  }

  const activeUsers = users.filter(u => u.status === 'active')
  const pendingUsers = users.filter(u => u.status === 'pending')

  return (
    <div className="p-4 lg:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Team Members</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {activeUsers.length} active{pendingUsers.length > 0 && ` · ${pendingUsers.length} pending`}
          </p>
        </div>
        <button
          onClick={() => { setShowInviteForm(!showInviteForm); setGeneratedLink(null) }}
          className="flex items-center gap-2 px-4 py-2 bg-[#2E9CE6] hover:bg-[#1A7BC4] text-white text-sm font-medium rounded-lg transition-colors"
        >
          <UserPlus size={16} />
          Invite User
        </button>
      </div>

      {/* Invite Form */}
      {showInviteForm && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
          <h2 className="text-sm font-bold text-gray-900 mb-4">Invite New Team Member</h2>
          <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-600 mb-1">Full Name</label>
              <input
                type="text"
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                placeholder="Jane Smith"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E9CE6]"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-600 mb-1">Email Address *</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                required
                placeholder="jane@theceo.store"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E9CE6]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'admin' | 'packer')}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] bg-white"
              >
                <option value="packer">Packer</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="flex items-end gap-2">
              <button
                type="submit"
                disabled={inviting}
                className="flex items-center gap-1.5 px-4 py-2 bg-[#2E9CE6] hover:bg-[#1A7BC4] disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {inviting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                {inviting ? 'Generating…' : 'Generate Invite Link'}
              </button>
              <button
                type="button"
                onClick={() => { setShowInviteForm(false); setGeneratedLink(null) }}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
          <p className="text-xs text-gray-400 mt-3">
            An invite link will be generated for you to copy and share. No email will be sent.
          </p>
        </div>
      )}

      {/* Generated Invite Link Banner */}
      {generatedLink && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-5">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Link2 size={16} className="text-green-600" />
              <span className="text-sm font-semibold text-green-800">Invite Link Generated</span>
            </div>
            <button
              onClick={dismissLink}
              className="p-1 text-green-400 hover:text-green-600 rounded transition-colors"
              title="Dismiss"
            >
              <X size={16} />
            </button>
          </div>
          <p className="text-xs text-green-700 mb-3">
            Copy this link and share it with the invited user. They will use it to set their password and access the portal.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={generatedLink}
              className="flex-1 px-3 py-2 bg-white border border-green-300 rounded-lg text-xs text-gray-700 font-mono focus:outline-none select-all"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button
              onClick={copyLink}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                linkCopied
                  ? 'bg-green-600 text-white'
                  : 'bg-[#2E9CE6] hover:bg-[#1A7BC4] text-white'
              }`}
            >
              {linkCopied ? <Check size={14} /> : <Copy size={14} />}
              {linkCopied ? 'Copied!' : 'Copy Link'}
            </button>
          </div>
        </div>
      )}

      {/* Users Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-[#2E9CE6]" />
          </div>
        ) : users.length === 0 ? (
          <div className="text-center py-16">
            <User size={40} className="mx-auto text-gray-300 mb-3" />
            <p className="text-gray-500 font-medium">No team members yet</p>
            <p className="text-gray-400 text-xs mt-1">Invite your first team member above</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-4 py-3 text-left font-semibold text-gray-600">User</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Role</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Status</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Joined</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold uppercase flex-shrink-0 ${
                        u.status === 'pending' ? 'bg-amber-400' : 'bg-[#2E9CE6]'
                      }`}>
                        {u.email.charAt(0)}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">{u.full_name || '—'}</p>
                        <p className="text-xs text-gray-400">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {u.status === 'active' ? (
                      <select
                        value={u.role}
                        onChange={(e) => handleRoleChange(u.id, e.target.value as 'admin' | 'packer')}
                        className="px-2.5 py-1 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] bg-white"
                      >
                        <option value="packer">Packer</option>
                        <option value="admin">Admin</option>
                      </select>
                    ) : (
                      <span className="text-xs text-gray-500 capitalize">{u.role}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.status === 'pending' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
                        <Clock size={10} />
                        Pending
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                        Active
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {formatDate(u.created_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {u.status === 'pending' && (
                        <button
                          onClick={() => handleReinvite(u.id, u.email, u.full_name || '', u.role)}
                          disabled={reinviting === u.id}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#2E9CE6] hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50"
                          title="Generate new invite link"
                        >
                          {reinviting === u.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <RefreshCw size={12} />
                          )}
                          New Link
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(u.id, u.email)}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        title="Remove user"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Role legend */}
      <div className="mt-4 flex gap-4 text-xs text-gray-400">
        <div className="flex items-center gap-1.5">
          <Shield size={12} className="text-[#2E9CE6]" />
          <span><strong>Admin:</strong> Full access — sync, invite, settings</span>
        </div>
        <div className="flex items-center gap-1.5">
          <User size={12} />
          <span><strong>Packer:</strong> View and download packing slips only</span>
        </div>
      </div>
    </div>
  )
}
