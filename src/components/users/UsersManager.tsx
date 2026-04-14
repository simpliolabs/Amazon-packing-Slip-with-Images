'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { UserPlus, Trash2, Shield, User, Loader2, Mail } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import type { UserProfile } from '@/types/database'

export default function UsersManager() {
  const [users, setUsers] = useState<UserProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [showInviteForm, setShowInviteForm] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'packer' | 'admin'>('packer')
  const [inviteName, setInviteName] = useState('')
  const [inviting, setInviting] = useState(false)

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

      toast.success(`Invitation sent to ${inviteEmail}`)
      setInviteEmail('')
      setInviteName('')
      setInviteRole('packer')
      setShowInviteForm(false)
      fetchUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invite failed')
    } finally {
      setInviting(false)
    }
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

  return (
    <div className="p-4 lg:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Team Members</h1>
          <p className="text-sm text-gray-500 mt-0.5">{users.length} user{users.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => setShowInviteForm(!showInviteForm)}
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
                {inviting ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
                {inviting ? 'Sending…' : 'Send Invite'}
              </button>
              <button
                type="button"
                onClick={() => setShowInviteForm(false)}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
          <p className="text-xs text-gray-400 mt-3">
            The user will receive a magic link email to set their password and access the portal.
          </p>
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
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Joined</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-[#2E9CE6] flex items-center justify-center text-white text-xs font-bold uppercase flex-shrink-0">
                        {u.email.charAt(0)}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">{u.full_name || '—'}</p>
                        <p className="text-xs text-gray-400">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={u.role}
                      onChange={(e) => handleRoleChange(u.id, e.target.value as 'admin' | 'packer')}
                      className="px-2.5 py-1 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] bg-white"
                    >
                      <option value="packer">Packer</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {formatDate(u.created_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDelete(u.id, u.email)}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                      title="Remove user"
                    >
                      <Trash2 size={14} />
                    </button>
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
