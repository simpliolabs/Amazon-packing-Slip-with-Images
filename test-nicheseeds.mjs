// Mirror of deriveNicheSeeds (keywordResearcher.ts) — verify the auto-niche gate against real cases.
const NICHE_APPAREL_RE = /\b(shirt|shirts|tee|tees|tshirt|tshirts|t-shirt|hoodie|sweatshirt|tank|top|tops)\b/i
const NICHE_GENERIC = new Set(['tshirt','tshirts','shirt','shirts','tee','tees','top','tops','apparel','clothing','comfort','colors','color','blank','cotton','graphic','unisex','mens','womens','women','men','plain','soft','vintage','oversized','premium'])
const nicheTokens = (s) => s.toLowerCase().replace(/[^a-z0-9'\s]/g,' ').split(/\s+/).filter(w=>w.length>2)
const nicheNorm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g,'')
function deriveNicheSeeds(identity, primarySeed, max=2){
  if(!identity) return []
  const primaryToks = new Set(nicheTokens(primarySeed))
  const productWord = NICHE_APPAREL_RE.test(identity.productType||'') ? (identity.productType||'').toLowerCase() : 'tshirt'
  const candidates = [...((identity.suggestedSearchTerms||[]).slice(1)), ...(identity.seedKeywords||[]), ...(identity.designTheme?[identity.designTheme]:[])]
  const out=[]; const seenNovel=new Set()
  for(const raw of candidates){
    if(out.length>=max) break
    let s=(raw||'').toLowerCase().replace(/[^a-z0-9'\s]/g,' ').replace(/\s+/g,' ').trim()
    if(!s) continue
    const novel = nicheTokens(s).filter(t=>!primaryToks.has(t)&&!NICHE_GENERIC.has(t))
    if(novel.length===0) continue
    if(novel.every(t=>seenNovel.has(t))) continue
    for(const t of novel) seenNovel.add(t)
    if(!NICHE_APPAREL_RE.test(s)) s=`${s} ${productWord}`
    s=s.split(/\s+/).slice(0,4).join(' ')
    out.push(s)
  }
  return out
}

let pass=0, fail=0
const eq=(name,got,want)=>{const g=JSON.stringify(got),w=JSON.stringify(want); if(g===w){pass++;console.log('  ok  ',name)}else{fail++;console.log('  FAIL',name,'\n    got ',g,'\n    want',w)}}

// 1. The faith case (B0FKKN8XKV) — design has a real niche → TWO DISTINCT niches (no christian dup)
eq('faith design → christian + bible verse (deduped)',
  deriveNicheSeeds({ designTheme:'Christian faith', seedKeywords:['christian','bible verse','faith'], suggestedSearchTerms:['comfort colors tshirt','christian tshirt'], productType:'SHIRT' }, 'comfort colors tshirt', 2),
  ['christian tshirt','bible verse shirt'])

// 2. Plain blank tee — no real niche (everything generic / covered by primary) → [] (no spend)
eq('plain blank tee → no niche',
  deriveNicheSeeds({ designTheme:'t-shirt', seedKeywords:['comfort colors','cotton tshirt'], suggestedSearchTerms:['comfort colors tshirt'], productType:'SHIRT' }, 'comfort colors tshirt', 2),
  [])

// 3. Fishing design → fishing + bass niches (product word 'shirt' from productType SHIRT)
eq('fishing design → fishing + bass seeds',
  deriveNicheSeeds({ designTheme:'bass fishing', seedKeywords:['fishing','bass'], suggestedSearchTerms:['comfort colors tshirt','fishing shirt'], productType:'SHIRT' }, 'comfort colors tshirt', 2),
  ['fishing shirt','bass shirt'])

// 4. Adds product word when the niche term lacks one (SHIRT → 'shirt')
eq('bare niche term gets product word',
  deriveNicheSeeds({ seedKeywords:['nurse'], suggestedSearchTerms:['comfort colors tshirt'], productType:'SHIRT' }, 'comfort colors tshirt', 2),
  ['nurse shirt'])

// 5. Null identity → []
eq('null identity → []', deriveNicheSeeds(null, 'comfort colors tshirt', 2), [])

// 6. Caps at max=2 even with many candidates
eq('caps at 2',
  deriveNicheSeeds({ seedKeywords:['christian','fishing','funny','nurse','teacher'], productType:'SHIRT' }, 'comfort colors tshirt', 2),
  ['christian shirt','fishing shirt'])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail?1:0)
