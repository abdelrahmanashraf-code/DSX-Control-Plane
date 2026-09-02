UPDATE provisioning_templates
   SET module_manifest = '["ds_access_control","ds_backend_branding","ds_business_dashboard","ds_login_branding","ds_pos_branding","ds_pos_delivery","ds_restaurant_theme","ds_ui_core","pos_customer_then_kitchen_receipt","pos_restaurant","restaurant_pos_recipe","wt_pos_access_right"]',
       settings_manifest = '{"source":"golden_template","source_database":"dsx_restaurant_demo_master"}',
       updated_at = CURRENT_TIMESTAMP
 WHERE id = 'template-restaurant-v1'
   AND sector = 'restaurant';
