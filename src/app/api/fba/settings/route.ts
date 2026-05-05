/**
 * FBA Intelligence Settings API
 * GET  /api/fba/settings  — returns current FBA settings
 * POST /api/fba/settings  — saves FBA settings to app_settings
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

const FBA_SETTING_KEYS = [
  'fba_lead_time_days',
  'fba_safety_buffer_days',
  'fba_replenish_trigger_weeks',
  'fba_new_candidate_min_units',
]

export async function GET() {
  const supabase = getAdminSupabase()

  const { data } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', FBA_SETTING_KEYS)

  const map: Record<string, string> = {}
  for (const row of data || []) {
    map[row.key] = row.value || ''
  }

  return NextResponse.json({
    leadTimeDays: parseInt(map['fba_lead_time_days'] || '14', 10),
    safetyBufferDays: parseInt(map['fba_safety_buffer_days'] || '15', 10),
    replenishTriggerWeeks: parseFloat(map['fba_replenish_trigger_weeks'] || '4'),
    newFBACandidateMinUnits: parseInt(map['fba_new_candidate_min_units'] || '5', 10),
  })
}

export async function POST(req: NextRequest) {
  const supabase = getAdminSupabase()

  let body: {
    leadTimeDays?: number
    safetyBufferDays?: number
    replenishTriggerWeeks?: number
    newFBACandidateMinUnits?: number
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const upserts = [
    { key: 'fba_lead_time_days', value: String(body.leadTimeDays ?? 14) },
    { key: 'fba_safety_buffer_days', value: String(body.safetyBufferDays ?? 15) },
    { key: 'fba_replenish_trigger_weeks', value: String(body.replenishTriggerWeeks ?? 4) },
    { key: 'fba_new_candidate_min_units', value: String(body.newFBACandidateMinUnits ?? 5) },
  ]

  const { error } = await supabase
    .from('app_settings')
    .upsert(upserts, { onConflict: 'key' })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
