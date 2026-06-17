import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('rec-retire2.json', 'utf8'))
const r = j.recommendations
console.log('=== B0GQVL3K4B (regenerated 18:50) ===')
console.log('generated_at:', r?.generated_at)
console.log('REC TITLE:', r?.recommended_title)
console.log('LIVE TITLE (current):', r?.live_title || r?.current_title || '(not in payload)')
console.log()
console.log('debug fields:', JSON.stringify(j.titleDebug ?? r?.titleDebug ?? r?.debug ?? '(none)', null, 2))
console.log()
const ap = r?.action_plan || []
const titleItem = ap.find((x) => x.element === 'title')
console.log('action_plan TITLE current_status:', titleItem?.current_status)
console.log()
console.log('BULLET 1:', (r?.recommended_bullets || [])[0])
console.log('BULLET 2:', (r?.recommended_bullets || [])[1])
console.log()
// What's the field_pushed_at NOW (post #230 deploy)?
console.log('field_pushed_at:', JSON.stringify(r?.field_pushed_at ?? {}))
