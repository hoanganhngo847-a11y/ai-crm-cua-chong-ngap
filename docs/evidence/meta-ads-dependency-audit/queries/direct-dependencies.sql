WITH roots AS (SELECT 'pg_class'::regclass AS classid,c.oid AS objid,0 AS objsubid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('survey_photo_operations','surveys','installations','warranty_tickets','production_orders','contracts','payment_transactions','operations_outbox','finance_summaries','orders','price_calculations','pricing_policies','company_bank_accounts','appointments'))
SELECT pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid) AS referenced,
pg_describe_object(d.classid,d.objid,d.objsubid) AS dependent,
d.classid::regclass::text AS class_name,d.objid,d.objsubid,d.deptype,
CASE WHEN d.classid='pg_constraint'::regclass THEN (SELECT conrelid::regclass::text FROM pg_constraint WHERE oid=d.objid)
WHEN d.classid='pg_trigger'::regclass THEN (SELECT tgrelid::regclass::text FROM pg_trigger WHERE oid=d.objid)
WHEN d.classid='pg_policy'::regclass THEN (SELECT polrelid::regclass::text FROM pg_policy WHERE oid=d.objid)
WHEN d.classid='pg_rewrite'::regclass THEN (SELECT ev_class::regclass::text FROM pg_rewrite WHERE oid=d.objid) END AS owning_relation
FROM pg_depend d JOIN roots r ON d.refclassid=r.classid AND d.refobjid=r.objid
ORDER BY referenced,dependent,d.deptype;
