// Mirror of scrubTrademarks — verify the FIFA World Cup case + idempotency + casing + tidy.
const TRADEMARK_RULES = [
  { mark: 'fifa\\s+world\\s+cup', sub: 'world soccer cup' },
  { mark: 'world\\s+cup', sub: 'world soccer cup' },
  { mark: 'super\\s*bowl', sub: 'big game' },
  { mark: 'fifa', sub: '' },
  { mark: 'olympics?', sub: '' },
  { mark: 'paralympics?', sub: '' },
  { mark: 'nfl', sub: '' }, { mark: 'nba', sub: '' }, { mark: 'mlb', sub: '' }, { mark: 'nhl', sub: '' }, { mark: 'ncaa', sub: '' },
]
function matchCase(sub, matched){ if(!sub) return sub; if(matched===matched.toUpperCase()) return sub.toUpperCase(); if(/^[A-Z]/.test(matched)) return sub.replace(/\b\w/g,c=>c.toUpperCase()); return sub }
function scrubTrademarks(text){ if(!text) return text; let out=text; for(const {mark,sub} of TRADEMARK_RULES){ const re=new RegExp(`\\b${mark}\\b`,'gi'); out=out.replace(re,m=>matchCase(sub,m)) } return out.replace(/\s{2,}/g,' ').replace(/\s+([,.;:])/g,'$1').replace(/,\s*,/g,',').replace(/^[\s,]+|[\s,]+$/g,'').trim() }

let pass=0,fail=0
const eq=(n,g,w)=>{if(g===w){pass++;console.log('  ok  ',n)}else{fail++;console.log('  FAIL',n,'\n    got ',JSON.stringify(g),'\n    want',JSON.stringify(w))}}

// THE case: World Cup → World Soccer Cup (Title Case preserved)
eq('Title-Case World Cup → World Soccer Cup', scrubTrademarks('Personalized 2026 World Cup T-Shirt'), 'Personalized 2026 World Soccer Cup T-Shirt')
// FIFA World Cup collapses to one safe phrase (no leftover "fifa")
eq('FIFA World Cup → World Soccer Cup', scrubTrademarks('FIFA World Cup 2026 Jersey'), 'World Soccer Cup 2026 Jersey')
// lowercase seed
eq('lowercase seed', scrubTrademarks('world cup soccer shirt'), 'world soccer cup soccer shirt')
// ALL-CAPS preserved
eq('ALLCAPS World Cup', scrubTrademarks('WORLD CUP FAN TEE'), 'WORLD SOCCER CUP FAN TEE')
// IDEMPOTENT — the safe phrase has no protected mark
eq('idempotent on safe phrase', scrubTrademarks('World Soccer Cup T-Shirt'), 'World Soccer Cup T-Shirt')
eq('double-scrub stable', scrubTrademarks(scrubTrademarks('World Cup Shirt')), scrubTrademarks('World Cup Shirt'))
// Drop with no synonym + tidy artifacts (no doubled space, no dangling)
eq('FIFA dropped + tidied', scrubTrademarks('Official FIFA Soccer Tee'), 'Official Soccer Tee')
eq('Olympics dropped', scrubTrademarks('2026 Olympics Gymnastics Shirt'), '2026 Gymnastics Shirt')
eq('Super Bowl → Big Game', scrubTrademarks('Super Bowl Party Shirt'), 'Big Game Party Shirt')
// Non-match untouched
eq('clean text untouched', scrubTrademarks('Funny Retirement Graphic Tee for Men'), 'Funny Retirement Graphic Tee for Men')
// the haitian world-cup pool keyword (would-be title injection) → safe
eq('haitian world cup keyword', scrubTrademarks('haitian jersey world cup 2026'), 'haitian jersey world soccer cup 2026')
// word-boundary: don't maul "worldcupping" nonsense or substrings (no \bworld cup\b inside)
eq('no false match inside word', scrubTrademarks('worldwide cupcakes'), 'worldwide cupcakes')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail?1:0)
