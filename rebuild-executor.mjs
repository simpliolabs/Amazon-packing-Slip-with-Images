// Rebuild src/lib/fba/pushExecutor.ts from the PRISTINE pre-#184 route bytes (git show,
// proper UTF-8) — the original assembly used PowerShell Get-Content, which misread the
// BOM-less UTF-8 file as ANSI and mojibake'd every non-ASCII char (— → â€", ─ → â"€),
// including user-facing string literals. This script redoes the line surgery + all the
// #184 conversions deterministically, asserting each replacement count.
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const src = execSync('git show 193c1d2:src/app/api/fba/listing-optimizer/push-content/route.ts', { encoding: 'utf8' })
const L = src.split(/\r?\n/)
if (L.length < 1070) throw new Error(`unexpected line count ${L.length}`)

const HEADER = `// ─── The push engine — shared by the streaming route and background jobs ───────
// Extracted verbatim from the POST handler of push-content/route.ts (PR #184) so
// the SAME battle-tested loop powers both delivery modes:
//   - streaming: the route wraps emit() around controller.enqueue (NDJSON to browser)
//   - jobs:      src/lib/fba/pushJobs.ts wraps emit() around push_jobs DB updates
// Event vocabulary (one emit per event):
//   {type:'started',  field, detail_field?, attribute_key?, total, broadcast}
//   {type:'progress', sku, status:'validating'|'accepted'|'failed', error?, submissionId?, current?, proposed?}
//   {type:'rescore',  message}
//   {type:'result',   pushed, failed, total, message, results, field, detail_field?, attribute_key?}
//   {type:'error',    error, results?}   — terminal; never thrown, always emitted
// executePush NEVER throws and NEVER returns a value: terminal failures emit {type:'error'}.

/** Params for one push execution — identical to the POST body minus \`confirm\`. */
export interface PushParams {
  parent_asin: string
  field?: string
  detail_field?: string
  skus?: string[]
  title_override?: string
  detail_value_override?: string
}

export type PushEmit = (obj: Record<string, unknown>) => void

export async function executePush(params: PushParams, emit: PushEmit): Promise<void> {
  const { parent_asin, field: rawField, detail_field: detailField, skus, title_override, detail_value_override } = params
  try {`

// Line surgery (1-based → 0-based slices): helpers 1-540, patchers 643-707, POST body 743-1055.
let out = [...L.slice(0, 540), ...L.slice(642, 707), '', ...HEADER.split('\n'), ...L.slice(742, 1055), '}'].join('\n')

const replaceCount = (s, from, to, expect) => {
  const n = s.split(from).length - 1
  if (n !== expect) throw new Error(`expected ${expect}x ${JSON.stringify(from.slice(0, 60))}, found ${n}`)
  return s.split(from).join(to)
}

out = replaceCount(out, "import { NextRequest, NextResponse } from 'next/server'\nimport { createAdminClient }", "import { createAdminClient }", 1)
out = replaceCount(out, 'const ENDPOINT       =', 'export const ENDPOINT       =', 1)
out = replaceCount(out, 'const MARKETPLACE_ID =', 'export const MARKETPLACE_ID =', 1)
out = replaceCount(out, 'async function getSellerId(', 'export async function getSellerId(', 1)
out = replaceCount(out, 'async function loadDiff(', 'export async function loadDiff(', 1)
out = replaceCount(out, 'async function loadDetailContext(', 'export async function loadDetailContext(', 1)
out = replaceCount(out, 'async function loadDetailDiff(', 'export async function loadDetailDiff(', 1)
out = replaceCount(out, 'controller.close(); return', 'return', 6)
out = replaceCount(out, `          results,
        })
        controller.close()
      } catch (err) {
        // Emit a structured error so the client can render it instead of choking.
        // No partial-results aggregation here: any SKU that already streamed a 'progress'
        // event has already informed the client what happened to it.
        emit({ type: 'error', error: err instanceof Error ? err.message : 'Push failed' })
        controller.close()
      }`, `          results,
        })
      } catch (err) {
        // Emit a structured error so the caller can render it instead of choking.
        // No partial-results aggregation here: any SKU that already emitted a 'progress'
        // event has already informed the caller what happened to it.
        emit({ type: 'error', error: err instanceof Error ? err.message : 'Push failed' })
      }`, 1)

if (/controller|encoder|new Response|ReadableStream/.test(out.replace(/around controller\.enqueue/, ''))) {
  throw new Error('stream artifacts remain: ' + (out.match(/.*(?:controller|encoder|new Response|ReadableStream).*/g) || []).join(' || '))
}
if (out.includes('â')) throw new Error('mojibake still present')

writeFileSync('src/lib/fba/pushExecutor.ts', out, 'utf8')
console.log('OK lines:', out.split('\n').length, '| mojibake-free:', !out.includes('â'))
