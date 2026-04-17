import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/audit'

/**
 * POST /api/downloads/log
 * Logs a download event with audit trail
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orderId, downloadType } = await request.json()

  const { error } = await supabase.from('download_logs').insert({
    order_id: orderId || null,
    user_id: user.id,
    download_type: downloadType || 'single',
  } as any)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Audit log for PII access (packing slips contain customer data)
  await logAudit({
    userId: user.id,
    action: downloadType === 'bulk' ? 'order.bulk_download' : 'order.download_pdf',
    resourceType: 'order',
    resourceId: orderId || undefined,
    details: { downloadType: downloadType || 'single' },
    ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
  })

  return NextResponse.json({ success: true })
}
