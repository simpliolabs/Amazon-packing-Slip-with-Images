const { createClient } = require('@supabase/supabase-js');

// Load .env.local
const fs = require('fs');
const envPath = '/home/ubuntu/Amazon-packing-Slip-with-Images/.env.local';
const envContent = fs.readFileSync(envPath, 'utf8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  // Get all keyword analysis grouped by ASIN
  const { data, error } = await sb.from('keyword_analysis').select('asin, action_type');
  if (error) { console.error(error); return; }
  
  const counts = {};
  for (const row of data) {
    if (!counts[row.asin]) counts[row.asin] = { CRITICAL: 0, UPGRADE: 0, REINFORCE: 0, DEFENDED: 0, OPTIMIZED: 0, total: 0 };
    const c = counts[row.asin];
    c[row.action_type] = (c[row.action_type] || 0) + 1;
    c.total++;
  }
  
  console.log('Keyword Intelligence Data by ASIN:');
  for (const [asin, c] of Object.entries(counts)) {
    console.log(asin, JSON.stringify(c));
  }
  
  // Also check listing_seo_recommendations for product_details_improvements
  const { data: recs } = await sb.from('listing_seo_recommendations').select('parent_asin, product_details_improvements');
  console.log('\nProduct Details Improvements by parent ASIN:');
  for (const r of (recs || [])) {
    const pdi = r.product_details_improvements;
    const count = Array.isArray(pdi) ? pdi.length : 0;
    console.log(r.parent_asin, 'improvements:', count);
  }
  
  // Check parent_asin_rollup to see which parent maps to which child
  const { data: rollup } = await sb.from('parent_asin_rollup').select('parent_asin, top_child_asin');
  console.log('\nParent → Top Child mapping:');
  for (const r of (rollup || [])) {
    console.log(r.parent_asin, '->', r.top_child_asin);
  }
  
  // Check listing_content to see which children exist for parents that have keyword data
  const kwAsins = Object.keys(counts);
  if (kwAsins.length > 0) {
    const { data: lc } = await sb.from('listing_content').select('asin, parent_asin').in('asin', kwAsins);
    console.log('\nKeyword ASINs found in listing_content:');
    for (const r of (lc || [])) {
      console.log(r.asin, 'parent:', r.parent_asin);
    }
  }
}
main();
