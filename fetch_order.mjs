/**
 * Fetch a single Amazon order via SP-API
 * Usage: node fetch_order.mjs
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
const ENDPOINT     = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const ORDER_ID     = '112-6563690-8857038'

async function getCredentials() {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: settings } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', ['amazon_client_id', 'amazon_client_secret', 'amazon_refresh_token'])
  
  if (!settings || settings.length < 3) {
    throw new Error('Missing Amazon credentials in Supabase app_settings')
  }
  const map = {}
  settings.forEach(s => { map[s.key] = s.value })
  return {
    clientId: map['amazon_client_id'],
    clientSecret: map['amazon_client_secret'],
    refreshToken: map['amazon_refresh_token'],
  }
}

async function getAccessToken(creds) {
  const resp = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
    }),
  })
  const data = await resp.json()
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`)
  return data.access_token
}

async function fetchOrder(token, orderId) {
  const resp = await fetch(`${ENDPOINT}/orders/v0/orders/${orderId}`, {
    headers: {
      'x-amz-access-token': token,
      'Accept': 'application/json',
    },
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`SP-API ${resp.status}: ${text}`)
  return JSON.parse(text)
}

async function fetchOrderItems(token, orderId) {
  const resp = await fetch(`${ENDPOINT}/orders/v0/orders/${orderId}/orderItems`, {
    headers: {
      'x-amz-access-token': token,
      'Accept': 'application/json',
    },
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`SP-API items ${resp.status}: ${text}`)
  return JSON.parse(text)
}

// Also check Supabase orders table
async function checkSupabase(orderId) {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('amazon_order_id', orderId)
    .single()
  return { data, error }
}

// Main
try {
  console.log(`\n=== Fetching order ${ORDER_ID} ===\n`)

  // 1. Check Supabase first
  console.log('--- Supabase DB record ---')
  const { data: dbRow, error: dbErr } = await checkSupabase(ORDER_ID)
  if (dbErr) {
    console.log('Not found in Supabase orders table:', dbErr.message)
  } else {
    console.log(JSON.stringify(dbRow, null, 2))
  }

  // 2. Fetch live from SP-API
  console.log('\n--- Live SP-API response ---')
  const creds = await getCredentials()
  const token = await getAccessToken(creds)

  const orderData = await fetchOrder(token, ORDER_ID)
  const order = orderData.payload || orderData
  console.log(JSON.stringify(order, null, 2))

  // 3. Fetch order items
  console.log('\n--- Order Items ---')
  const itemsData = await fetchOrderItems(token, ORDER_ID)
  const items = (itemsData.payload || itemsData).OrderItems || []
  console.log(JSON.stringify(items, null, 2))

} catch (err) {
  console.error('ERROR:', err.message)
}
