SELECT 'appointments' AS name,count(*)::bigint AS exact_rows FROM public.appointments
UNION ALL
SELECT 'contracts' AS name,count(*)::bigint AS exact_rows FROM public.contracts
UNION ALL
SELECT 'finance_summaries' AS name,count(*)::bigint AS exact_rows FROM public.finance_summaries
UNION ALL
SELECT 'installations' AS name,count(*)::bigint AS exact_rows FROM public.installations
UNION ALL
SELECT 'operations_outbox' AS name,count(*)::bigint AS exact_rows FROM public.operations_outbox
UNION ALL
SELECT 'orders' AS name,count(*)::bigint AS exact_rows FROM public.orders
UNION ALL
SELECT 'payment_transactions' AS name,count(*)::bigint AS exact_rows FROM public.payment_transactions
UNION ALL
SELECT 'price_calculations' AS name,count(*)::bigint AS exact_rows FROM public.price_calculations
UNION ALL
SELECT 'pricing_policies' AS name,count(*)::bigint AS exact_rows FROM public.pricing_policies
UNION ALL
SELECT 'production_orders' AS name,count(*)::bigint AS exact_rows FROM public.production_orders
UNION ALL
SELECT 'survey_photo_operations' AS name,count(*)::bigint AS exact_rows FROM public.survey_photo_operations
UNION ALL
SELECT 'surveys' AS name,count(*)::bigint AS exact_rows FROM public.surveys
UNION ALL
SELECT 'warranty_tickets' AS name,count(*)::bigint AS exact_rows FROM public.warranty_tickets
ORDER BY name;
