'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import {
  LayoutDashboard,
  Settings,
  Users,
  LogOut,
  Menu,
  X,
  RefreshCw,
  Package,
  KeyRound,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface DashboardLayoutProps {
  children: React.ReactNode
  userRole?: 'admin' | 'packer'
  userEmail?: string
}

export default function DashboardLayout({
  children,
  userRole = 'packer',
  userEmail = '',
}: DashboardLayoutProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const supabase = createClient()

  const navItems = [
    {
      href: '/',
      label: 'Orders',
      icon: LayoutDashboard,
      roles: ['admin', 'packer'],
    },
    {
      href: '/fba',
      label: 'FBA Intel',
      icon: Package,
      roles: ['admin', 'packer'],
    },
    {
      href: '/fba/keywords',
      label: 'Keyword Pool',
      icon: KeyRound,
      roles: ['admin', 'packer'],
    },
    {
      href: '/settings',
      label: 'Settings',
      icon: Settings,
      roles: ['admin'],
    },
    {
      href: '/users',
      label: 'Users',
      icon: Users,
      roles: ['admin'],
    },
  ].filter((item) => item.roles.includes(userRole))

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  async function handleSyncNow() {
    setSyncing(true)
    try {
      const res = await fetch('/api/sync', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        toast.success(`Sync complete — ${data.ordersInserted} orders updated`)
        // Dispatch custom event so OrdersTable re-fetches data
        window.dispatchEvent(new Event('sync-complete'))
        router.refresh()
      } else {
        toast.error(data.error || 'Sync failed')
      }
    } catch {
      toast.error('Sync request failed')
    } finally {
      setSyncing(false)
    }
  }

  const Sidebar = () => (
    <div className="flex flex-col h-full bg-white border-r border-gray-200">
      {/* Logo */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-gray-200">
        <Link href="/">
          <Image
            src="/logo.png"
            alt="TheCEO.Store"
            width={120}
            height={54}
            className="object-contain"
          />
        </Link>
        <button
          onClick={() => setSidebarOpen(false)}
          className="lg:hidden p-1 rounded text-gray-400 hover:text-gray-600"
        >
          <X size={20} />
        </button>
      </div>

      {/* Sync Now button (all roles) */}
      <div className="px-4 py-3 border-b border-gray-100">
        <button
          onClick={handleSyncNow}
          disabled={syncing}
          className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-[#2E9CE6] hover:bg-[#1A7BC4] disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Syncing…' : 'Sync Now'}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setSidebarOpen(false)}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-[#2E9CE6]/10 text-[#2E9CE6]'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              )}
            >
              <Icon size={18} />
              {item.label}
            </Link>
          )
        })}
      </nav>

      {/* User info + Sign out */}
      <div className="px-4 py-4 border-t border-gray-200">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-full bg-[#2E9CE6] flex items-center justify-center text-white text-xs font-bold uppercase">
            {userEmail.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-gray-900 truncate">{userEmail}</p>
            <p className="text-xs text-gray-400 capitalize">{userRole}</p>
          </div>
        </div>
        <button
          onClick={handleSignOut}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
        >
          <LogOut size={16} />
          Sign out
        </button>
      </div>
    </div>
  )

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex lg:w-64 lg:flex-shrink-0">
        <div className="w-64 fixed inset-y-0">
          <Sidebar />
        </div>
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="fixed inset-0 bg-black/30"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 w-64 z-50">
            <Sidebar />
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 lg:ml-64">
        {/* Mobile header */}
        <div className="lg:hidden flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100"
          >
            <Menu size={20} />
          </button>
          <Image
            src="/logo.png"
            alt="TheCEO.Store"
            width={100}
            height={45}
            className="object-contain"
          />
        </div>

        {/* Page content */}
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  )
}
