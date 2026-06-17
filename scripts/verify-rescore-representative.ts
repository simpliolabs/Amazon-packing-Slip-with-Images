/**
 * Runtime proof for pickRescoreRepresentative — the post-push re-score's representative-row picker.
 * Run: npx tsx scripts/verify-rescore-representative.ts
 *
 * Regression target: after a content push, pushExecutor drops the variation PARENT (hub) row from the
 * diff — only the CHILD rows are write-through-updated, so the parent's listing_content row is STALE.
 * The scorer prefers `parentContent`, so a family whose parent has its own row and whose children can't
 * reconstruct the title via longest-common-prefix (a 1-child family) used to re-score the PRE-push
 * title/bullets/description. This proves the picker scores the fresh top-child instead, and leaves the
 * common case (no parent-own row) byte-for-byte unchanged.
 */
import { pickRescoreRepresentative } from '../src/lib/fba/rescoreRepresentative'

let pass = 0, fail = 0
const fails: string[] = []
function ok(cond: boolean, msg: string) {
  if (cond) pass++
  else { fail++; fails.push(msg); console.error('  ✗ ' + msg) }
}

const PARENT = 'B0PARENT'
const TOPCHILD = 'B0CHILDTOP'
const row = (asin: string, title: string) => ({ asin, title })

// [1] THE BUG — 1-child family with a stale parent-own row: score the FRESH child, not the stale parent.
const oneChild = pickRescoreRepresentative(
  [row(PARENT, 'OLD stale parent title'), row(TOPCHILD, 'NEW freshly pushed title')],
  PARENT, TOPCHILD,
)
ok(oneChild.representative?.asin === TOPCHILD, '1-child family: representative is the fresh child, not the stale parent')
ok(oneChild.representative?.title === 'NEW freshly pushed title', '1-child family: representative carries the freshly-pushed title')
ok(!oneChild.scoredRows.some((r) => r.asin === PARENT), '1-child family: stale parent row is dropped from the scored set')

// [2] top_child_asin unset → fall back to the first child, still excluding the stale parent.
const noTop = pickRescoreRepresentative(
  [row(PARENT, 'OLD'), row('B0C1', 'NEW1'), row('B0C2', 'NEW2')],
  PARENT, null,
)
ok(noTop.representative?.asin === 'B0C1', 'no top_child_asin: representative falls back to the first child')
ok(noTop.scoredRows.length === 2 && !noTop.scoredRows.some((r) => r.asin === PARENT), 'no top_child_asin: parent still excluded')

// [3] COMMON CASE — no parent-own row present → inputs returned UNCHANGED (zero behavior change; the
//     scorer keeps its own freshest-child fallback exactly as before this fix).
const commonRows = [row('B0C1', 'T1'), row(TOPCHILD, 'T2')]
const common = pickRescoreRepresentative(commonRows, PARENT, TOPCHILD)
ok(common.representative === null, 'no parent-own row: representative is null so the scorer uses its own fallback')
ok(common.scoredRows === commonRows, 'no parent-own row: scoredRows is the original array reference, untouched')

// [4] top_child_asin points at the (dropped) parent → still pick a real child, never the stale parent.
const topIsParent = pickRescoreRepresentative([row(PARENT, 'OLD'), row('B0C1', 'NEW1')], PARENT, PARENT)
ok(topIsParent.representative?.asin === 'B0C1', 'top_child_asin === parent: never selects the stale parent as representative')

// [5] DEFENSIVE — only the parent row exists (a push would not normally re-score this) → no crash,
//     never an empty scored set; falls back to prior behavior.
const parentOnly = pickRescoreRepresentative([row(PARENT, 'OLD')], PARENT, null)
ok(parentOnly.representative?.asin === PARENT && parentOnly.scoredRows.length === 1, 'parent-only set: falls back gracefully, never scores empty')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) { console.error('\nFAILURES:\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1) }
else console.log('All pickRescoreRepresentative checks passed.')
