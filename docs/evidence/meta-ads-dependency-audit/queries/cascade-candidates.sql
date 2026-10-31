WITH RECURSIVE roots AS (
 SELECT 'pg_class'::regclass::oid AS classid,c.oid AS objid,0 AS objsubid FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('survey_photo_operations','surveys','installations','warranty_tickets','production_orders','contracts','payment_transactions','operations_outbox','finance_summaries','orders','price_calculations','pricing_policies','company_bank_accounts','appointments')
 UNION SELECT 'pg_proc'::regclass::oid,p.oid,0 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('accept_installation_appointment_atomic','begin_survey_photo_operation','claim_contract_generation_rpc','complete_installation_atomic','complete_survey_atomic','create_installation_schedule_atomic','create_order_from_calculation_rpc','create_production_order_atomic','create_warranty_ticket_atomic','end_survey_photo_operation','enforce_appointments_immutability','enforce_contracts_immutability','enforce_installations_integrity','enforce_orders_immutability','enforce_payment_facts_immutability','enforce_price_calculations_immutability','enforce_pricing_policies_immutability','enforce_surveys_integrity','finalize_contract_signing_rpc','finalize_generated_contract_rpc','generate_order_code','guard_survey_appointment_write','is_assigned_technician','mutate_installation_atomic','operations_actor','operations_audit','operations_evidence_ref','process_payment_webhook_rpc','save_price_calculation_rpc','start_installation_work_atomic','update_order_deposit_rpc','update_production_progress_atomic','update_warranty_status_atomic')
), edges AS (
 SELECT refclassid AS src_class,refobjid AS src_id,refobjsubid AS src_sub,classid AS dst_class,objid AS dst_id,objsubid AS dst_sub FROM pg_depend WHERE deptype IN ('n','a','i','P','S','x')
 UNION ALL
 SELECT classid,objid,objsubid,refclassid,refobjid,refobjsubid FROM pg_depend WHERE deptype='i'
), closure(classid,objid,objsubid) AS (
 SELECT classid,objid,objsubid FROM roots
 UNION
 SELECT e.dst_class,e.dst_id,e.dst_sub FROM closure c JOIN edges e ON e.src_class=c.classid AND e.src_id=c.objid AND (c.objsubid=0 OR c.objsubid=e.src_sub)
)
SELECT c.classid::regclass::text AS catalog,c.objid,c.objsubid,pg_describe_object(c.classid,c.objid,c.objsubid) AS description,
EXISTS(SELECT 1 FROM roots r WHERE (r.classid,r.objid,r.objsubid)=(c.classid,c.objid,c.objsubid)) AS root,
CASE WHEN c.classid='pg_constraint'::regclass THEN (SELECT conrelid::regclass::text FROM pg_constraint WHERE oid=c.objid)
WHEN c.classid='pg_trigger'::regclass THEN (SELECT tgrelid::regclass::text FROM pg_trigger WHERE oid=c.objid)
WHEN c.classid='pg_policy'::regclass THEN (SELECT polrelid::regclass::text FROM pg_policy WHERE oid=c.objid)
WHEN c.classid='pg_rewrite'::regclass THEN (SELECT ev_class::regclass::text FROM pg_rewrite WHERE oid=c.objid)
WHEN c.classid='pg_attrdef'::regclass THEN (SELECT adrelid::regclass::text FROM pg_attrdef WHERE oid=c.objid)
WHEN c.classid='pg_class'::regclass THEN (SELECT CASE WHEN relkind IN ('i','I') THEN (SELECT indrelid::regclass::text FROM pg_index WHERE indexrelid=c.objid) ELSE oid::regclass::text END FROM pg_class WHERE oid=c.objid)
END AS owning_relation FROM closure c ORDER BY catalog,description;
