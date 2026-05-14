-- Migration 007: Add label/shipment tracking to fba_inventory
-- Tracks when shipping labels are created for FBA inbound shipments,
-- bridging the gap between label creation and Amazon receiving inventory.

-- Add label tracking columns to fba_inventory
ALTER TABLE fba_inventory
  ADD COLUMN IF NOT EXISTS label_created_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS shipment_status text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS shipment_id text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS label_notes text DEFAULT NULL;

-- shipment_status values:
--   NULL          = no pending shipment
--   'label_created' = label printed, awaiting carrier pickup
--   'shipped'     = carrier has picked up
--   'in_transit'  = in transit to Amazon FC
--   'delivered'   = delivered to Amazon FC
--   'receiving'   = Amazon is receiving/checking in
--   'closed'      = fully received by Amazon

COMMENT ON COLUMN fba_inventory.label_created_at IS 'When the FBA shipping label was created for this SKU';
COMMENT ON COLUMN fba_inventory.shipment_status IS 'Current shipment lifecycle status (label_created, shipped, in_transit, etc.)';
COMMENT ON COLUMN fba_inventory.shipment_id IS 'Amazon shipment ID or inbound plan ID';
COMMENT ON COLUMN fba_inventory.label_notes IS 'User notes about the shipment (carrier, tracking, etc.)';

-- Index for quick lookup of items with pending shipments
CREATE INDEX IF NOT EXISTS idx_fba_inventory_shipment_status
  ON fba_inventory (shipment_status)
  WHERE shipment_status IS NOT NULL;
