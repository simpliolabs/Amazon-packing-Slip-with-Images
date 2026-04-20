export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      orders: {
        Row: {
          id: string
          purchase_date: string
          buyer_name: string | null
          buyer_email: string | null
          ship_to: ShipTo | null
          order_items: OrderItem[]
          fulfillment_channel: string | null
          order_status: string | null
          raw_data: Json | null
          synced_at: string
          created_at: string
        }
        Insert: {
          id: string
          purchase_date: string
          buyer_name?: string | null
          buyer_email?: string | null
          ship_to?: ShipTo | null
          order_items?: OrderItem[]
          fulfillment_channel?: string | null
          order_status?: string | null
          raw_data?: Json | null
          synced_at?: string
          created_at?: string
        }
        Update: {
          id?: string
          purchase_date?: string
          buyer_name?: string | null
          buyer_email?: string | null
          ship_to?: ShipTo | null
          order_items?: OrderItem[]
          fulfillment_channel?: string | null
          order_status?: string | null
          raw_data?: Json | null
          synced_at?: string
          created_at?: string
        }
      }
      user_profiles: {
        Row: {
          id: string
          email: string
          full_name: string | null
          role: 'admin' | 'packer'
          invite_token: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          email: string
          full_name?: string | null
          role?: 'admin' | 'packer'
          invite_token?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          email?: string
          full_name?: string | null
          role?: 'admin' | 'packer'
          invite_token?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      download_logs: {
        Row: {
          id: string
          order_id: string | null
          user_id: string | null
          download_type: 'single' | 'bulk'
          created_at: string
        }
        Insert: {
          id?: string
          order_id?: string | null
          user_id?: string | null
          download_type: 'single' | 'bulk'
          created_at?: string
        }
        Update: {
          id?: string
          order_id?: string | null
          user_id?: string | null
          download_type?: 'single' | 'bulk'
          created_at?: string
        }
      }
      sync_logs: {
        Row: {
          id: string
          started_at: string
          completed_at: string | null
          orders_synced: number
          status: 'running' | 'success' | 'error'
          error_message: string | null
        }
        Insert: {
          id?: string
          started_at?: string
          completed_at?: string | null
          orders_synced?: number
          status?: 'running' | 'success' | 'error'
          error_message?: string | null
        }
        Update: {
          id?: string
          started_at?: string
          completed_at?: string | null
          orders_synced?: number
          status?: 'running' | 'success' | 'error'
          error_message?: string | null
        }
      }
      app_settings: {
        Row: {
          key: string
          value: string | null
          updated_at: string
        }
        Insert: {
          key: string
          value?: string | null
          updated_at?: string
        }
        Update: {
          key?: string
          value?: string | null
          updated_at?: string
        }
      }
    }
    Views: Record<string, never>
    Functions: {
      delete_old_orders: {
        Args: Record<string, never>
        Returns: void
      }
    }
    Enums: Record<string, never>
  }
}

// ---- Domain types ----

export interface ShipTo {
  name: string
  addressLine1: string
  addressLine2?: string
  city: string
  stateOrRegion: string
  postalCode: string
  countryCode: string
  phone?: string
}

export interface OrderItem {
  asin: string
  sku: string
  title: string
  qty: number
  image_url: string | null
  price?: string
  order_item_id?: string
}

export type Order = Database['public']['Tables']['orders']['Row']
export type UserProfile = Database['public']['Tables']['user_profiles']['Row']
export type DownloadLog = Database['public']['Tables']['download_logs']['Row']
export type SyncLog = Database['public']['Tables']['sync_logs']['Row']
