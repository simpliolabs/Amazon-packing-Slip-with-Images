// Mirror of validateSeeds + the identity/relevance helpers — verify the Seed Agent's
// deterministic guard rails against the B0GVW83L1P soccer case + hallucination/dedup edges.
const SEED_GENERIC = new Set(['2020','2021','2022','2023','2024','2025','2026','2027','2028','2029','2030','personalized','custom','customized','graphic','graphics','vintage','retro','classic','premium','quality','soft','blank','original','novelty','unisex','plain','small','medium','large','xl','2xl','3xl','4xl','5xl','xxl','xxxl','black','white','red','blue','green','navy','gray','grey','yellow','pink','purple','brown','orange','beige','men','mens','women','womens','ladies','kid','kids','toddler','baby','adult','youth','comfort','colors','gildan','jerzees','dickies','carhartt','bella','canvas','for','and','with','the','a','an','of','to','in','on','at','by','or'])
const APPAREL_WORDS = new Set(['shirt','shirts','tshirt','tshirts','t-shirt','tee','tees','top','tops','hoodie','sweatshirt','tank'])
function identityTokensOf(...sources){const out=new Set();for(const s of sources){if(!s)continue;for(const raw of s.toLowerCase().replace(/[^a-z0-9'\s]/g,' ').split(/\s+/).filter(Boolean)){const w=raw.replace(/s$/,'');if(w.length<=2)continue;if(SEED_GENERIC.has(w)||APPAREL_WORDS.has(w))continue;if(/^\d+$/.test(w))continue;out.add(w)}}return out}
function keywordIsRelevant(keyword,identity){if(identity.size===0)return true;for(const raw of keyword.toLowerCase().replace(/[^a-z0-9'\s]/g,' ').split(/\s+/).filter(Boolean)){const w=raw.replace(/s$/,'');if(w.length<=2)continue;if(SEED_GENERIC.has(w)||APPAREL_WORDS.has(w))continue;if(identity.has(w))return true}return false}
function validateSeeds(rawSeeds,identity,productWord='tshirt'){const out=[];const seen=new Set();for(const raw of rawSeeds){let s=(raw||'').toLowerCase().replace(/[^a-z0-9'\s]/g,' ').replace(/\s+/g,' ').trim();if(!s)continue;if(identity.size>0&&!keywordIsRelevant(s,identity))continue;if(!s.split(/\s+/).some(w=>APPAREL_WORDS.has(w)))s=`${s} ${productWord}`;s=s.split(/\s+/).slice(0,4).join(' ');const key=s.replace(/[^a-z0-9]/g,'');if(seen.has(key))continue;seen.add(key);out.push(s);if(out.length>=3)break}return out}

let pass=0,fail=0
const eq=(n,g,w)=>{const a=JSON.stringify(g),b=JSON.stringify(w);if(a===b){pass++;console.log('  ok  ',n)}else{fail++;console.log('  FAIL',n,'\n    got ',a,'\n    want',b)}}

const soccerTitle="Personalized 2026 World Soccer Cup T-Shirt – Fan Tee, USA, Mexico, Canada Host Countries Shirt - 5X-Large - White"
const id=identityTokensOf(soccerTitle)
console.log('soccer identity:', [...id].join(', '))

// 1. Good agent output for soccer → all kept (already on-identity, product words present)
eq('soccer agent seeds kept', validateSeeds(['world cup soccer shirt','usa soccer fan tee','world cup 2026 shirt'], id), ['world cup soccer shirt','usa soccer fan tee','world cup 2026 shirt'])

// 2. HALLUCINATION guard — agent emits an off-identity seed; it's dropped
eq('drops off-identity hallucination', validateSeeds(['world cup soccer shirt','family vacation shirts 2026'], id), ['world cup soccer shirt'])

// 3. Product-word append when missing
eq('appends product word', validateSeeds(['world cup soccer'], id, 'shirt'), ['world cup soccer shirt'])

// 4. Exact-dup removed + cap at 3 (near-dups like "soccer shirt"/"soccer tshirt" are NOT merged —
//    the agent at temp 0 won't emit both; theme-level dedup is a PR2 concern for multi-universe spend)
eq('exact-dup removed + cap 3', validateSeeds(['soccer shirt','soccer shirt','world cup tee','usa soccer top','canada soccer tee'], id), ['soccer shirt','world cup tee','usa soccer top'])

// 5. ALL off-identity (pure hallucination run) → empty → triggers rules failover + escalation
eq('all-hallucination → empty (escalate path)', validateSeeds(['family cruise shirts','disney matching tees','graduation 2026 shirt'], id), [])

// 6. Empty identity (no listing data) → accept (can't gate), still append product word
eq('empty identity accepts', validateSeeds(['anything goes'], new Set(), 'shirt'), ['anything goes shirt'])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail?1:0)
