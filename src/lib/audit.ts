/**
 * Audit Logger — DPP Compliance
 * Logs all access to Amazon PII and sensitive operations.
 */

import { createClient } from '@supabase/supabase-js'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export type AuditAction =
  | 'order.view'
  | 'order.download_pdf'
  | 'order.bulk_download'
  | 'sync.trigger_manual'
  | 'sync.trigger_cron'
  | 'settings.view'
  | 'settings.update_credentials'
  | 'user.login'
  | 'user.invite'
  | 'user.delete'
  | 'user.update_role'

export interface AuditLogEntry {
  userId: string | null
  action: AuditAction
  resourceType: string
  resourceId?: string
  details?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
}

/**
 * Write an audit log entry. Fire-and-forget — errors are logged
 * but never block the main operation.
 */
export async function logAudit(entry: AuditLogEntry): Promise<void> {
  try {
    const supabase = getAdminSupabase()
    await supabase.from('audit_logs').insert({
      user_id: entry.userId,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId || null,
      details: entry.details || {},
      ip_address: entry.ipAddress || null,
      user_agent: entry.userAgent || null,
    })
  } catch (err) {
    console.error('[audit] Failed to write audit log:', err)
  }
}
