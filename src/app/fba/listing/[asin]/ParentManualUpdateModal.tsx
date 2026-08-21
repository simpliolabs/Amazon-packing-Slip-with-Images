'use client'

/**
 * ParentManualUpdateModal — Item A (2026-07-21, PO approved via workflow wg9somp8u).
 *
 * WHY: variation-parent hubs occasionally reach a state where every SP-API write path silent-drops
 * (Amazon rule 99022 on an orphan shirt_size composite is the verified case — workflow wob0iqomq
 * exhausted every alternative). When we detect that state, the push executor SKIPS the parent PATCH
 * (no more red "1 failed" on every push) and this popup surfaces the exact fields the operator
 * needs to complete in Seller Central + one click to open the right edit page.
 *
 * WHAT it renders:
 *   - Which composite is blocking (shirt_size, apparel_size, etc.)
 *   - Side-by-side stored vs recommended for Title / Bullets / Description / Keywords, with a Copy
 *     button per field so the operator can paste each into Seller Central without retyping.
 *   - A big "Open in Seller Central" deep-link jumping to Product Details for the parent SKU.
 *   - Dismiss: "I'll do it later" (silent) OR "I updated it — re-verify" (calls the existing
 *     /api/fba/listing-optimizer/heal-state force-clear so the next push enqueues a fresh heal).
 *
 * SURGICAL: no new API routes, no new DB tables, no new tRPC. Consumes state the page already has.
 */

import { useState } from 'react'
import { parentVariationsUrl, inventorySearchUrl } from '@/lib/fba/sellerCentralUrls'

interface Props {
  parentAsin: string
  parentSku?: string | null
  productType?: string | null
  containers: string[]
  /** FALSE = we never loaded the parent's stored copy (no listing_content row for the hub). The
   *  stored column then says so instead of rendering "(none)", which read as "Amazon has nothing". */
  storedAvailable: boolean
  storedTitle: string
  storedBullets: string[]
  storedDescription: string
  storedKeywords: string
  recommendedTitle: string
  recommendedBullets: string[]
  recommendedDescription: string
  recommendedKeywords: string
  onDismiss: () => void
  onReVerify: (containerKey: string) => Promise<void>
}

const CONTAINER_LABELS: Record<string, string> = {
  shirt_size: 'Shirt Size (System / Class / Size)',
  apparel_size: 'Apparel Size (System / Class / Size)',
  item_package_dimensions: 'Package Dimensions (L × W × H)',
  item_package_weight: 'Package Weight',
  // Sentinel from the push executor: Amazon rejected the parent write but named no attribute —
  // the operator still needs to fix the parent in Seller Central (generic wording, no field list).
  parent_update: 'listing record (Amazon rejected the update without naming a field)',
}

export function ParentManualUpdateModal(props: Props) {
  const [copied, setCopied] = useState<string | null>(null)
  const [reVerifying, setReVerifying] = useState(false)
  // Deep-link to the Variations tab (not the generic edit page) — that's where the operator actually
  // completes the composite the popup exists for. PO verified 2026-07-21 that /abis/listing/edit
  // opens a stub without the composite fields.
  //
  // 2026-08-21 (PO, live on B0DQ5YZH38: "the product LINK doesn't work"): the url is built by ONE
  // shared module now (sellerCentralUrls.ts). The parent SKU arrives from the heal:composite payload
  // when there is one and from /family-skus otherwise — the old code required BOTH props and every
  // listing without an active heal task got the ASIN-only stub. If the SKU is genuinely unresolvable
  // the builder hands over the inventory search, which always resolves; it NEVER emits the stub.
  const sellerCentralUrl = parentVariationsUrl({
    sku: props.parentSku,
    asin: props.parentAsin,
    productType: props.productType,
  })
  const isFallbackSearch = sellerCentralUrl === inventorySearchUrl(props.parentAsin)
  const primaryContainer = props.containers[0] ?? 'shirt_size'
  const bulletsAsText = (arr: string[]): string => arr.map((b, i) => `${i + 1}. ${b}`).join('\n')

  const copy = async (label: string, value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500)
    } catch { /* clipboard blocked — user can still select+copy manually */ }
  }

  const rows: { key: string; label: string; stored: string; recommended: string }[] = [
    { key: 'title', label: 'Title', stored: props.storedTitle, recommended: props.recommendedTitle },
    { key: 'bullets', label: 'Bullets', stored: bulletsAsText(props.storedBullets), recommended: bulletsAsText(props.recommendedBullets) },
    { key: 'description', label: 'Description', stored: props.storedDescription, recommended: props.recommendedDescription },
    { key: 'keywords', label: 'Backend Keywords', stored: props.storedKeywords, recommended: props.recommendedKeywords },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/60 p-6">
      <div className="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Parent hub needs manual update</h2>
            <p className="mt-1 text-sm text-slate-600">
              The variation parent hub can&apos;t accept API writes right now — its <strong className="font-medium">{CONTAINER_LABELS[primaryContainer] ?? primaryContainer}</strong>{' '}
              composite needs to be completed in Seller Central. Children shipped successfully; the parent&apos;s stored copy stays stale until you complete this once.
            </p>
          </div>
          <button
            type="button"
            onClick={props.onDismiss}
            aria-label="Dismiss"
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
          </button>
        </div>

        <div className="mt-4">
          <a
            href={sellerCentralUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            {isFallbackSearch ? 'Find Parent in Seller Central Inventory' : 'Open Parent in Seller Central'}
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4"><path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" /><path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" /></svg>
          </a>
          {isFallbackSearch ? (
            <p className="mt-2 text-xs text-amber-700">
              We couldn&apos;t resolve this hub&apos;s seller SKU, so this opens your inventory filtered to{' '}
              <span className="font-mono">{props.parentAsin}</span> — click the parent SKU there to reach its Variations tab.
            </p>
          ) : (
            <p className="mt-2 text-xs text-slate-500">
              Opens the Variations tab for parent SKU <span className="font-mono">{props.parentSku}</span>.
            </p>
          )}
        </div>

        <div className="mt-5 border-t border-slate-200 pt-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Copy each field into the matching Seller Central input
          </div>
          <div className="space-y-3">
            {rows.map((r) => (
              <div key={r.key} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-700">{r.label}</div>
                  <button
                    type="button"
                    onClick={() => copy(r.key, r.recommended)}
                    disabled={!r.recommended?.trim()}
                    className={`rounded-md px-3 py-1 text-xs font-medium ${r.recommended?.trim() ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'cursor-not-allowed bg-slate-200 text-slate-400'}`}
                  >
                    {copied === r.key ? 'Copied ✓' : 'Copy recommended'}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="mb-1 text-slate-500">Stored on Amazon</div>
                    {/* HONESTY (PO 2026-08-21): when we never loaded the hub's stored copy this used to
                        render "(none)", which reads as "Amazon has nothing" — a claim we can't make.
                        Say "not loaded" instead and keep "(none)" for a row we DID load and that is
                        genuinely empty. */}
                    <div className={`max-h-24 overflow-auto whitespace-pre-wrap rounded border p-2 font-mono text-[11px] ${props.storedAvailable ? 'border-slate-200 bg-white text-slate-500' : 'border-dashed border-slate-300 bg-slate-50 italic text-slate-400'}`}>
                      {props.storedAvailable
                        ? (r.stored?.trim() || '(none)')
                        : 'not loaded — check the live value in Seller Central'}
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 text-emerald-700">Recommended (copy this)</div>
                    <div className="max-h-24 overflow-auto whitespace-pre-wrap rounded border border-emerald-200 bg-white p-2 font-mono text-[11px] text-slate-800">{r.recommended?.trim() || '(no recommendation cached — regenerate first)'}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
          <button
            type="button"
            onClick={props.onDismiss}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            I&apos;ll do it later
          </button>
          <button
            type="button"
            onClick={async () => {
              setReVerifying(true)
              try { await props.onReVerify(primaryContainer) } finally { setReVerifying(false); props.onDismiss() }
            }}
            disabled={reVerifying}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${reVerifying ? 'cursor-wait bg-slate-400' : 'bg-emerald-600 hover:bg-emerald-700'}`}
          >
            {reVerifying ? 'Re-verifying...' : 'I updated it — re-verify'}
          </button>
        </div>
      </div>
    </div>
  )
}
