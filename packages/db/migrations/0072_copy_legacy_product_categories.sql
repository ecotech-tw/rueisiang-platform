-- product_categories previously served both WMS and report screens. Copy only names
-- that have report-side usage; unused WMS names remain warehouse-only and a name used
-- by both domains gets one independent row in each dictionary.
INSERT OR IGNORE INTO report_product_categories (id, name, color, created_at, updated_at)
SELECT 'report-' || id, name, color, created_at, updated_at
FROM warehouse_categories
WHERE EXISTS (
  SELECT 1 FROM _legacy_cyberbiz_product_categories
  WHERE _legacy_cyberbiz_product_categories.category_id = warehouse_categories.id
)
OR EXISTS (
  SELECT 1 FROM custom_report_products
  WHERE custom_report_products.category = warehouse_categories.name
);
--> statement-breakpoint
-- Restore the assignments after the generated schema migration rebuilt the child table.
INSERT OR IGNORE INTO cyberbiz_product_categories (sku, category_id, created_at, updated_at)
SELECT sku, 'report-' || category_id, created_at, updated_at
FROM _legacy_cyberbiz_product_categories
WHERE EXISTS (
  SELECT 1 FROM report_product_categories
  WHERE report_product_categories.id = 'report-' || _legacy_cyberbiz_product_categories.category_id
);
--> statement-breakpoint
-- A report-only legacy name must not remain visible in the WMS shelf dictionary.
DELETE FROM warehouse_categories
WHERE EXISTS (
  SELECT 1 FROM report_product_categories
  WHERE report_product_categories.id = 'report-' || warehouse_categories.id
)
AND NOT EXISTS (
  SELECT 1 FROM inventory_items
  WHERE inventory_items.category = warehouse_categories.name
)
AND NOT EXISTS (
  SELECT 1 FROM zones
  WHERE zones.category = warehouse_categories.name
);
--> statement-breakpoint
DROP TABLE _legacy_cyberbiz_product_categories;
