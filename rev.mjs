import { readFileSync } from 'node:fs'
const intel = JSON.parse(readFileSync('rev-intel.json','utf8'))
const rec = JSON.parse(readFileSync('rev-rec.json','utf8')).recommendations
const rank = JSON.parse(readFileSync('rev-rank.json','utf8'))

const kws = intel.allKeywords || []
console.log('=== INTELLIGENCE POOL ('+kws.length+' kw) ===')
const soccer = kws.filter(k=>/soccer|world cup|fifa|jersey|fan|haitian|mexico|england|supporter|match/i.test(k.keyword)).length
const pollut = kws.filter(k=>/family|graduation|reunion|disney|cruise|vacation|graduate|dad shirt|mom of/i.test(k.keyword)).length
console.log('soccer/world-cup themed:', soccer, '| family/graduation pollution:', pollut)
console.log('actionType counts:', JSON.stringify((()=>{const c={};for(const k of kws)c[k.actionType]=(c[k.actionType]||0)+1;return c})()))

console.log('\n=== PUBLISHED CONTENT — trademark check (must be NO raw "world cup"/"fifa") ===')
const title = rec?.recommended_title || ''
const bullets = rec?.recommended_bullets || []
const backends = (rec?.per_child_keywords||[]).map(c=>c.keywords)
console.log('TITLE:', title)
const rawWC = (s)=>/\bworld cup\b/i.test(s) || /\bfifa\b/i.test(s)
console.log('  title has raw trademark?', rawWC(title))
bullets.forEach((b,i)=>console.log(`  bullet ${i+1} raw TM? ${rawWC(b)} :: ${b.slice(0,90)}`))
console.log('  backend has raw TM? (any child):', backends.some(rawWC))
console.log('  "world soccer cup" present in title?', /world soccer cup/i.test(title))

console.log('\n=== RANK CARD (Rank Top of Amazon) — stale check ===')
const rrows = (rank.rows||[])
const rankPollut = rrows.filter(r=>/family|graduation|disney|cruise|vacation/i.test(r.keyword))
console.log('rank rows:', rrows.length, '| family/graduation pollutants still in rank card:', rankPollut.length)
rankPollut.slice(0,5).forEach(r=>console.log('   ⚠ STALE:', r.keyword, r.actionType||r.contentAction?.slice(0,20)))
console.log('rank analyzedAt:', rank.analyzedAt, 'stale flag:', rank.stale)
