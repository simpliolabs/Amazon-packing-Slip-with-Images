-- ============================================================
-- Migration 012: Protect customization data in order_items
-- ============================================================
-- Adds a BEFORE UPDATE trigger on the orders table that prevents
-- any write to order_items from silently erasing customization
-- data that was previously stored on an item.
--
-- The trigger iterates over every item in the NEW order_items array.
-- If the corresponding item in the OLD array has a non-null
-- customization object, and the NEW item has a null/missing
-- customization, the trigger copies the OLD customization into
-- the NEW item before the row is written.
--
-- This is a last-resort safety net that fires even if application-
-- level guards are bypassed (e.g. direct DB access, future code
-- paths, or concurrent writes).
-- ============================================================

CREATE OR REPLACE FUNCTION protect_order_items_customization()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  new_items  jsonb;
  old_items  jsonb;
  new_item   jsonb;
  old_item   jsonb;
  i          int;
  j          int;
  matched    boolean;
BEGIN
  -- Only run when order_items is actually being changed
  IF NEW.order_items IS NULL OR NEW.order_items = OLD.order_items THEN
    RETURN NEW;
  END IF;

  new_items := NEW.order_items;
  old_items := OLD.order_items;

  -- Iterate over every item in the incoming (NEW) array
  FOR i IN 0 .. jsonb_array_length(new_items) - 1 LOOP
    new_item := new_items -> i;

    -- Skip if this item already has customization data
    IF new_item -> 'customization' IS NOT NULL
       AND new_item ->> 'customization' != 'null' THEN
      CONTINUE;
    END IF;

    -- Search the OLD array for a matching item by order_item_id or asin
    matched := false;
    FOR j IN 0 .. jsonb_array_length(old_items) - 1 LOOP
      old_item := old_items -> j;

      IF (
        (new_item ->> 'order_item_id' IS NOT NULL
         AND new_item ->> 'order_item_id' = old_item ->> 'order_item_id')
        OR
        (new_item ->> 'asin' IS NOT NULL
         AND new_item ->> 'asin' = old_item ->> 'asin')
      ) THEN
        -- Found a match — check if old item had customization
        IF old_item -> 'customization' IS NOT NULL
           AND old_item ->> 'customization' != 'null' THEN
          -- Restore the customization from the old item
          new_items := jsonb_set(
            new_items,
            ARRAY[i::text, 'customization'],
            old_item -> 'customization',
            true
          );
          RAISE LOG 'protect_order_items_customization: Restored customization for asin=% on order=%',
            new_item ->> 'asin', NEW.id;
        END IF;
        matched := true;
        EXIT; -- stop inner loop once matched
      END IF;
    END LOOP;
  END LOOP;

  NEW.order_items := new_items;
  RETURN NEW;
END;
$$;

-- Drop existing trigger if it exists (idempotent)
DROP TRIGGER IF EXISTS trg_protect_order_items_customization ON orders;

-- Create the trigger — fires BEFORE every UPDATE on orders
CREATE TRIGGER trg_protect_order_items_customization
  BEFORE UPDATE OF order_items ON orders
  FOR EACH ROW
  EXECUTE FUNCTION protect_order_items_customization();

COMMENT ON FUNCTION protect_order_items_customization() IS
  'Prevents any UPDATE from silently erasing customization data '
  'that was previously stored in order_items. Acts as a last-resort '
  'safety net below the application-level merge guards in syncOrders.ts.';
