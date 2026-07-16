'use client'

import { useEffect, type ReactNode } from 'react'

/**
 * ModalShell — one dialog primitive so modals dismiss ONLY via the prominent X (or Escape),
 * never via an accidental backdrop click (PO: "modals are super easy to close when clicking
 * outside — they should only close via X"). The backdrop deliberately has NO onClick handler.
 *
 * Mounted === visible: render it behind a truthiness guard (`{open && <ModalShell/>}`) so the
 * Escape listener subscribes only while the dialog is up, and so children that dereference the
 * open target aren't evaluated while closed.
 */
export function ModalShell({
  onClose,
  title,
  maxW = 'max-w-md',
  scroll = false,
  dismissDisabled = false,
  children,
}: {
  onClose: () => void
  title: ReactNode
  /** Tailwind max-width class for the card (e.g. "max-w-md", "max-w-2xl"). */
  maxW?: string
  /** Cap height at 85vh and scroll the body (for tall/preview modals). */
  scroll?: boolean
  /** While true, X + Escape are inert (e.g. a live write is in flight). */
  dismissDisabled?: boolean
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !dismissDisabled) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismissDisabled, onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className={`bg-white rounded-2xl shadow-xl w-full ${maxW} ${scroll ? 'max-h-[85vh] overflow-y-auto' : ''}`}>
        <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-200 sticky top-0 bg-white z-10">
          <div className="min-w-0 flex-1 text-sm font-bold text-slate-900">{title}</div>
          <ModalCloseButton onClick={onClose} disabled={dismissDisabled} />
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * The prominent close control — a 32px filled circle with an X glyph and an accessible label.
 * Shared so every modal (shell-based or hand-rolled streaming ones) uses the identical target.
 */
export function ModalCloseButton({
  onClick,
  title,
  disabled = false,
}: {
  onClick: () => void
  title?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => { if (!disabled) onClick() }}
      disabled={disabled}
      aria-label="Close"
      title={title ?? 'Close'}
      className="shrink-0 grid place-items-center w-8 h-8 rounded-full text-slate-500 bg-slate-100 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
    >
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  )
}
