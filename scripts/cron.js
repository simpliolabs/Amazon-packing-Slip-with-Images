/**
 * Background Cron Job — Order Sync
 * Runs every 30 minutes and calls the /api/sync endpoint
 * Managed by PM2 as a separate process
 */

const cron = require('node-cron')

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
const CRON_SECRET = process.env.CRON_SECRET

if (!CRON_SECRET) {
  console.error('[CRON] CRON_SECRET environment variable is not set. Exiting.')
  process.exit(1)
}

console.log('[CRON] Starting FBM order sync cron job...')
console.log(`[CRON] Will sync every 30 minutes → ${APP_URL}/api/sync`)

// Run every 30 minutes
cron.schedule('*/30 * * * *', async () => {
  const timestamp = new Date().toISOString()
  console.log(`[CRON] ${timestamp} — Triggering order sync...`)

  try {
    const response = await fetch(`${APP_URL}/api/sync`, {
      method: 'POST',
      headers: {
        'x-cron-secret': CRON_SECRET,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      const text = await response.text()
      console.error(`[CRON] Sync failed with status ${response.status}: ${text}`)
      return
    }

    const data = await response.json()
    if (data.success) {
      console.log(`[CRON] Sync complete — ${data.ordersInserted}/${data.ordersProcessed} orders updated`)
    } else {
      console.error(`[CRON] Sync error: ${data.error}`)
    }
  } catch (err) {
    console.error(`[CRON] Request failed:`, err.message)
  }
})

// Also run once on startup
;(async () => {
  console.log('[CRON] Running initial sync on startup...')
  try {
    const response = await fetch(`${APP_URL}/api/sync`, {
      method: 'POST',
      headers: {
        'x-cron-secret': CRON_SECRET,
        'Content-Type': 'application/json',
      },
    })
    const data = await response.json()
    console.log('[CRON] Initial sync result:', JSON.stringify(data))
  } catch (err) {
    console.error('[CRON] Initial sync failed:', err.message)
  }
})()
