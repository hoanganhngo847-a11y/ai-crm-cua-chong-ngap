# Legacy dependency inventory

All 14 tables and all 33 dynamic function-name targets are included. Current catalog entries are distinct from objects introduced by pending migrations.

## Tables

### appointments

Current staging: 0 exact rows.

**Constraints**

- `appointments_assignee_id_fkey`: `FOREIGN KEY (assignee_id) REFERENCES user_profiles(id) ON DELETE RESTRICT`
- `appointments_company_id_fkey`: `FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT`
- `appointments_pkey`: `PRIMARY KEY (id)`
- `appointments_status_check`: `CHECK (status = ANY (ARRAY['ASSIGNED'::text, 'ACCEPTED'::text, 'IN_PROGRESS'::text, 'COMPLETED'::text, 'CANCELLED'::text, 'REJECTED'::text]))`
- `appointments_type_check`: `CHECK (type = ANY (ARRAY['SURVEY'::text, 'INSTALLATION'::text]))`
- `fk_appointments_customer`: `FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id) ON DELETE RESTRICT`
- `fk_installations_appointment`: `FOREIGN KEY (company_id, customer_id, appointment_id) REFERENCES appointments(company_id, customer_id, id) ON DELETE RESTRICT`
- `fk_surveys_appointment`: `FOREIGN KEY (company_id, customer_id, appointment_id) REFERENCES appointments(company_id, customer_id, id) ON DELETE RESTRICT`
- `survey_photo_operations_appointment_id_fkey`: `FOREIGN KEY (appointment_id) REFERENCES appointments(id)`
- `uq_appointments_company_customer_id`: `UNIQUE (company_id, customer_id, id)`

**Indexes**

- `appointments_pkey`: `CREATE UNIQUE INDEX appointments_pkey ON public.appointments USING btree (id)`
- `idx_appointments_company_survey_created`: `CREATE INDEX idx_appointments_company_survey_created ON public.appointments USING btree (company_id, created_at) WHERE (type = 'SURVEY'::text)`
- `idx_appointments_technician`: `CREATE INDEX idx_appointments_technician ON public.appointments USING btree (company_id, assignee_id, start_time)`
- `uq_appointments_company_customer_id`: `CREATE UNIQUE INDEX uq_appointments_company_customer_id ON public.appointments USING btree (company_id, customer_id, id)`

**Triggers**

- `guard_survey_appointment_write`: `CREATE TRIGGER guard_survey_appointment_write BEFORE INSERT OR UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION guard_survey_appointment_write()`
- `trg_appointments_immutability`: `CREATE TRIGGER trg_appointments_immutability BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION enforce_appointments_immutability()`
- `trg_tenant_mutation_appointments`: `CREATE TRIGGER trg_tenant_mutation_appointments BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION prevent_tenant_mutation()`
- `trg_updated_at_appointments`: `CREATE TRIGGER trg_updated_at_appointments BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`

**Policies**

- `appointments_insert_boss_admin`: `roles=['authenticated']; using=None; command=INSERT; with_check=has_company_role(company_id, 'BOSS_ADMIN'::text)`
- `appointments_insert_sale`: `roles=['authenticated']; using=None; command=INSERT; with_check=has_company_role(company_id, 'SALE'::text)`
- `appointments_select_assigned_technician`: `roles=['authenticated']; using=(has_company_role(company_id, 'TECHNICIAN'::text) AND (assignee_id = auth.uid()) AND (status = ANY (ARRAY['ASSIGNED'::text, 'ACCEPTED'::text, 'IN_PROGRESS'::text]))); command=SELECT; with_check=None`
- `appointments_select_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=SELECT; with_check=None`
- `appointments_select_sale`: `roles=['authenticated']; using=has_company_role(company_id, 'SALE'::text); command=SELECT; with_check=None`
- `appointments_update_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=UPDATE; with_check=has_company_role(company_id, 'BOSS_ADMIN'::text)`
- `appointments_update_sale`: `roles=['authenticated']; using=has_company_role(company_id, 'SALE'::text); command=UPDATE; with_check=has_company_role(company_id, 'SALE'::text)`

**Literal query consumers**

- `lib/server-auth/resource-access.ts:228` (library_or_configuration).
- `lib/server-auth/resource-access.ts:274` (library_or_configuration).
- `lib/server-auth/resource-access.ts:333` (library_or_configuration).
- `lib/server-auth/resource-access.ts:422` (library_or_configuration).

**Removed functions that reference this table before cleanup**

- `public.accept_installation_appointment_atomic(uuid,uuid,uuid)` at `20261004180001_installation_product_journey.sql:157`.
- `public.begin_survey_photo_operation(uuid,uuid)` at `20260924000001_survey_integrity_hardening.sql:26`.
- `public.complete_installation_atomic(uuid,uuid,uuid,jsonb,text)` at `20261004180001_installation_product_journey.sql:370`.
- `public.complete_survey_atomic(uuid,uuid,jsonb)` at `20260924000001_survey_integrity_hardening.sql:127`.
- `public.create_installation_schedule_atomic(uuid,uuid,uuid,uuid,timestamptz,text,jsonb)` at `20261004210001_installation_rls_and_scheduling_authority.sql:67`.
- `public.end_survey_photo_operation(uuid,uuid)` at `20260924000001_survey_integrity_hardening.sql:71`.
- `public.enforce_installations_integrity()` at `20260914000001_initial_schema.sql:1197`.
- `public.enforce_surveys_integrity()` at `20260914000001_initial_schema.sql:1065`.
- `public.is_assigned_technician(uuid)` at `20260915000001_rls_foundation.sql:66`.
- `public.mutate_installation_atomic(uuid,uuid,uuid,text,text,text)` at `20261004210001_installation_rls_and_scheduling_authority.sql:244`.
- `public.start_installation_work_atomic(uuid,uuid,uuid)` at `20261004180001_installation_product_journey.sql:227`.

### company_bank_accounts

Current staging: ABSENT.

**Constraints**

- None observed.

**Indexes**

- None observed.

**Triggers**

- None observed.

**Policies**

- None observed.

**Literal query consumers**

- None found; this does not cover clients outside the repository.

**Removed functions that reference this table before cleanup**

- `public.process_payment_webhook_rpc(text,text,text,numeric,timestamptz,text,text)` at `20260929220003_commercial_security_hardening.sql:6`.

### contracts

Current staging: 0 exact rows.

**Constraints**

- `contracts_company_id_fkey`: `FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT`
- `contracts_contract_value_check`: `CHECK (contract_value >= 0::numeric)`
- `contracts_pkey`: `PRIMARY KEY (id)`
- `contracts_revision_no_check`: `CHECK (revision_no >= 1)`
- `contracts_status_check`: `CHECK (status = ANY (ARRAY['GENERATED'::text, 'SENT_TO_CUSTOMER'::text, 'SIGNED'::text, 'REJECTED'::text, 'SUPERSEDED'::text]))`
- `fk_contracts_order`: `FOREIGN KEY (company_id, order_id) REFERENCES orders(company_id, id) ON DELETE RESTRICT`
- `uq_contracts_order_revision`: `UNIQUE (order_id, revision_no)`

**Indexes**

- `contracts_pkey`: `CREATE UNIQUE INDEX contracts_pkey ON public.contracts USING btree (id)`
- `idx_contracts_status`: `CREATE INDEX idx_contracts_status ON public.contracts USING btree (company_id, status)`
- `uq_contracts_order_current`: `CREATE UNIQUE INDEX uq_contracts_order_current ON public.contracts USING btree (order_id) WHERE (is_current = true)`
- `uq_contracts_order_revision`: `CREATE UNIQUE INDEX uq_contracts_order_revision ON public.contracts USING btree (order_id, revision_no)`

**Triggers**

- `trg_contracts_immutability`: `CREATE TRIGGER trg_contracts_immutability BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION enforce_contracts_immutability()`
- `trg_tenant_mutation_contracts`: `CREATE TRIGGER trg_tenant_mutation_contracts BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION prevent_tenant_mutation()`
- `trg_updated_at_contracts`: `CREATE TRIGGER trg_updated_at_contracts BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`

**Policies**

- `contracts_select_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=SELECT; with_check=None`
- `contracts_select_sale`: `roles=['authenticated']; using=has_company_role(company_id, 'SALE'::text); command=SELECT; with_check=None`
- `contracts_update_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=UPDATE; with_check=has_company_role(company_id, 'BOSS_ADMIN'::text)`

**Literal query consumers**

- `lib/sensitive/signed-urls.ts:107` (library_or_configuration).
- `lib/server-auth/resource-access.ts:527` (library_or_configuration).
- `lib/server-auth/resource-access.ts:546` (library_or_configuration).

**Removed functions that reference this table before cleanup**

- `public.claim_contract_generation_rpc(uuid,uuid,bool)` at `20260929220003_commercial_security_hardening.sql:350`.
- `public.create_production_order_atomic(uuid,uuid,uuid,jsonb,jsonb,timestamptz)` at `20260930120001_p1_backend_remediation.sql:39`.
- `public.finalize_contract_signing_rpc(uuid,uuid,uuid,text,text)` at `20260929220003_commercial_security_hardening.sql:513`.
- `public.finalize_generated_contract_rpc(uuid,uuid,text)` at `20260929220003_commercial_security_hardening.sql:467`.

### finance_summaries

Current staging: 0 exact rows.

**Constraints**

- `finance_summaries_collected_amount_check`: `CHECK (collected_amount >= 0::numeric)`
- `finance_summaries_company_id_fkey`: `FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT`
- `finance_summaries_completed_revenue_check`: `CHECK (completed_revenue >= 0::numeric)`
- `finance_summaries_contract_value_check`: `CHECK (contract_value >= 0::numeric)`
- `finance_summaries_pkey`: `PRIMARY KEY (order_id)`
- `finance_summaries_receivable_amount_check`: `CHECK (receivable_amount >= 0::numeric)`
- `fk_finance_summaries_order`: `FOREIGN KEY (company_id, order_id) REFERENCES orders(company_id, id) ON DELETE RESTRICT`

**Indexes**

- `finance_summaries_pkey`: `CREATE UNIQUE INDEX finance_summaries_pkey ON public.finance_summaries USING btree (order_id)`
- `idx_finance_summaries_company`: `CREATE INDEX idx_finance_summaries_company ON public.finance_summaries USING btree (company_id)`

**Triggers**

- `trg_tenant_mutation_finance`: `CREATE TRIGGER trg_tenant_mutation_finance BEFORE UPDATE ON finance_summaries FOR EACH ROW EXECUTE FUNCTION prevent_tenant_mutation()`
- `trg_updated_at_finance_summaries`: `CREATE TRIGGER trg_updated_at_finance_summaries BEFORE UPDATE ON finance_summaries FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`

**Policies**

- `finance_summaries_select_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=SELECT; with_check=None`

**Literal query consumers**

- None found; this does not cover clients outside the repository.

**Removed functions that reference this table before cleanup**

- `public.create_order_from_calculation_rpc(uuid,uuid,uuid,text,uuid)` at `20261002220001_commercial_exactly_once_and_recovery.sql:80`.
- `public.process_payment_webhook_rpc(text,text,text,numeric,timestamptz,text,text)` at `20260929220003_commercial_security_hardening.sql:6`.
- `public.update_order_deposit_rpc(uuid,uuid,uuid,numeric,text)` at `20261002220001_commercial_exactly_once_and_recovery.sql:247`.

### installations

Current staging: 0 exact rows.

**Constraints**

- `fk_installations_appointment`: `FOREIGN KEY (company_id, customer_id, appointment_id) REFERENCES appointments(company_id, customer_id, id) ON DELETE RESTRICT`
- `fk_installations_customer`: `FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id) ON DELETE RESTRICT`
- `fk_installations_order`: `FOREIGN KEY (company_id, customer_id, order_id) REFERENCES orders(company_id, customer_id, id) ON DELETE RESTRICT`
- `fk_wt_installation`: `FOREIGN KEY (company_id, customer_id, order_id, installation_id) REFERENCES installations(company_id, customer_id, order_id, id) ON DELETE RESTRICT`
- `installations_company_id_fkey`: `FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT`
- `installations_order_id_key`: `UNIQUE (order_id)`
- `installations_pkey`: `PRIMARY KEY (id)`
- `installations_status_check`: `CHECK (status = ANY (ARRAY['SCHEDULED'::text, 'IN_TRANSIT'::text, 'INSTALLING'::text, 'TESTING'::text, 'HANDOVER_PENDING'::text, 'COMPLETED'::text, 'FAILED'::text]))`
- `uq_installations_company_customer_order_id`: `UNIQUE (company_id, customer_id, order_id, id)`

**Indexes**

- `idx_installations_status`: `CREATE INDEX idx_installations_status ON public.installations USING btree (company_id, status)`
- `installations_order_id_key`: `CREATE UNIQUE INDEX installations_order_id_key ON public.installations USING btree (order_id)`
- `installations_pkey`: `CREATE UNIQUE INDEX installations_pkey ON public.installations USING btree (id)`
- `uq_installations_company_customer_order_id`: `CREATE UNIQUE INDEX uq_installations_company_customer_order_id ON public.installations USING btree (company_id, customer_id, order_id, id)`

**Triggers**

- `trg_installations_integrity`: `CREATE TRIGGER trg_installations_integrity BEFORE INSERT OR UPDATE ON installations FOR EACH ROW EXECUTE FUNCTION enforce_installations_integrity()`
- `trg_tenant_mutation_installations`: `CREATE TRIGGER trg_tenant_mutation_installations BEFORE UPDATE ON installations FOR EACH ROW EXECUTE FUNCTION prevent_tenant_mutation()`
- `trg_updated_at_installations`: `CREATE TRIGGER trg_updated_at_installations BEFORE UPDATE ON installations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`

**Policies**

- `installations_select_assigned_technician`: `roles=['authenticated']; using=(has_company_role(company_id, 'TECHNICIAN'::text) AND is_assigned_technician(appointment_id)); command=SELECT; with_check=None`
- `installations_select_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=SELECT; with_check=None`
- `installations_select_sale`: `roles=['authenticated']; using=has_company_role(company_id, 'SALE'::text); command=SELECT; with_check=None`
- `installations_update_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=UPDATE; with_check=has_company_role(company_id, 'BOSS_ADMIN'::text)`

**Literal query consumers**

- `lib/server-auth/resource-access.ts:396` (library_or_configuration).
- `lib/server-auth/resource-access.ts:452` (library_or_configuration).

**Removed functions that reference this table before cleanup**

- `public.complete_installation_atomic(uuid,uuid,uuid,jsonb,text)` at `20261004180001_installation_product_journey.sql:370`.
- `public.create_installation_schedule_atomic(uuid,uuid,uuid,uuid,timestamptz,text,jsonb)` at `20261004210001_installation_rls_and_scheduling_authority.sql:67`.
- `public.create_warranty_ticket_atomic(uuid,uuid,uuid,uuid,uuid,text,text,text)` at `20260930120001_p1_backend_remediation.sql:368`.
- `public.enforce_appointments_immutability()` at `20260914000001_initial_schema.sql:1043`.
- `public.mutate_installation_atomic(uuid,uuid,uuid,text,text,text)` at `20261004210001_installation_rls_and_scheduling_authority.sql:244`.
- `public.start_installation_work_atomic(uuid,uuid,uuid)` at `20261004180001_installation_product_journey.sql:227`.

### operations_outbox

Current staging: 0 exact rows.

**Constraints**

- `operations_outbox_company_id_fkey`: `FOREIGN KEY (company_id) REFERENCES companies(id)`
- `operations_outbox_company_id_order_id_event_type_key`: `UNIQUE (company_id, order_id, event_type)`
- `operations_outbox_event_type_check`: `CHECK (event_type = 'ORDER_COMPLETED'::text)`
- `operations_outbox_order_fk`: `FOREIGN KEY (company_id, order_id) REFERENCES orders(company_id, id)`
- `operations_outbox_pkey`: `PRIMARY KEY (id)`

**Indexes**

- `operations_outbox_company_id_order_id_event_type_key`: `CREATE UNIQUE INDEX operations_outbox_company_id_order_id_event_type_key ON public.operations_outbox USING btree (company_id, order_id, event_type)`
- `operations_outbox_pkey`: `CREATE UNIQUE INDEX operations_outbox_pkey ON public.operations_outbox USING btree (id)`

**Triggers**

- None observed.

**Policies**

- None observed.

**Literal query consumers**

- None found; this does not cover clients outside the repository.

**Removed functions that reference this table before cleanup**

- `public.complete_installation_atomic(uuid,uuid,uuid,jsonb,text)` at `20261004180001_installation_product_journey.sql:370`.

### orders

Current staging: 0 exact rows.

**Constraints**

- `fk_contracts_order`: `FOREIGN KEY (company_id, order_id) REFERENCES orders(company_id, id) ON DELETE RESTRICT`
- `fk_finance_summaries_order`: `FOREIGN KEY (company_id, order_id) REFERENCES orders(company_id, id) ON DELETE RESTRICT`
- `fk_installations_order`: `FOREIGN KEY (company_id, customer_id, order_id) REFERENCES orders(company_id, customer_id, id) ON DELETE RESTRICT`
- `fk_orders_customer`: `FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id) ON DELETE RESTRICT`
- `fk_orders_pricing`: `FOREIGN KEY (company_id, customer_id, price_calculation_id) REFERENCES price_calculations(company_id, customer_id, id) ON DELETE RESTRICT`
- `fk_production_orders_order`: `FOREIGN KEY (company_id, order_id) REFERENCES orders(company_id, id) ON DELETE RESTRICT`
- `fk_pt_matched_order`: `FOREIGN KEY (company_id, matched_order_id) REFERENCES orders(company_id, id) ON DELETE RESTRICT`
- `fk_wt_order`: `FOREIGN KEY (company_id, customer_id, order_id) REFERENCES orders(company_id, customer_id, id) ON DELETE RESTRICT`
- `operations_outbox_order_fk`: `FOREIGN KEY (company_id, order_id) REFERENCES orders(company_id, id)`
- `orders_company_id_fkey`: `FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT`
- `orders_deposit_status_check`: `CHECK (deposit_status = ANY (ARRAY['PENDING'::text, 'DEPOSIT_PENDING'::text, 'CONFIRMED'::text, 'DEPOSIT_CONFIRMED'::text, 'REFUNDED'::text]))`
- `orders_final_amount_check`: `CHECK (final_amount >= 0::numeric)`
- `orders_order_status_check`: `CHECK (order_status = ANY (ARRAY['DRAFT'::text, 'DEPOSIT_CONFIRMED'::text, 'CONTRACT_SIGNED'::text, 'IN_PRODUCTION'::text, 'READY_FOR_INSTALL'::text, 'INSTALLING'::text, 'HANDOVER_COMPLETED'::text, 'HANDED_OVER'::text, 'COMPLETED'::text, 'CANCELLED'::text]))`
- `orders_pkey`: `PRIMARY KEY (id)`
- `uq_orders_company_customer_id`: `UNIQUE (company_id, customer_id, id)`
- `uq_orders_company_id`: `UNIQUE (company_id, id)`
- `uq_orders_company_order_code`: `UNIQUE (company_id, order_code)`
- `uq_orders_company_payment_ref`: `UNIQUE (company_id, payment_reference)`

**Indexes**

- `idx_orders_company_created_at`: `CREATE INDEX idx_orders_company_created_at ON public.orders USING btree (company_id, created_at)`
- `idx_orders_customer`: `CREATE INDEX idx_orders_customer ON public.orders USING btree (company_id, customer_id)`
- `idx_orders_status`: `CREATE INDEX idx_orders_status ON public.orders USING btree (company_id, order_status)`
- `orders_pkey`: `CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)`
- `uq_orders_company_customer_id`: `CREATE UNIQUE INDEX uq_orders_company_customer_id ON public.orders USING btree (company_id, customer_id, id)`
- `uq_orders_company_id`: `CREATE UNIQUE INDEX uq_orders_company_id ON public.orders USING btree (company_id, id)`
- `uq_orders_company_order_code`: `CREATE UNIQUE INDEX uq_orders_company_order_code ON public.orders USING btree (company_id, order_code)`
- `uq_orders_company_payment_ref`: `CREATE UNIQUE INDEX uq_orders_company_payment_ref ON public.orders USING btree (company_id, payment_reference)`

**Triggers**

- `trg_orders_immutability`: `CREATE TRIGGER trg_orders_immutability BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION enforce_orders_immutability()`
- `trg_tenant_mutation_orders`: `CREATE TRIGGER trg_tenant_mutation_orders BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION prevent_tenant_mutation()`
- `trg_updated_at_orders`: `CREATE TRIGGER trg_updated_at_orders BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`

**Policies**

- `orders_select_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=SELECT; with_check=None`

**Literal query consumers**

- `lib/server-auth/resource-access.ts:480` (library_or_configuration).
- `lib/server-auth/resource-access.ts:499` (library_or_configuration).

**Removed functions that reference this table before cleanup**

- `public.claim_contract_generation_rpc(uuid,uuid,bool)` at `20260929220003_commercial_security_hardening.sql:350`.
- `public.complete_installation_atomic(uuid,uuid,uuid,jsonb,text)` at `20261004180001_installation_product_journey.sql:370`.
- `public.create_installation_schedule_atomic(uuid,uuid,uuid,uuid,timestamptz,text,jsonb)` at `20261004210001_installation_rls_and_scheduling_authority.sql:67`.
- `public.create_order_from_calculation_rpc(uuid,uuid,uuid,text,uuid)` at `20261002220001_commercial_exactly_once_and_recovery.sql:80`.
- `public.create_production_order_atomic(uuid,uuid,uuid,jsonb,jsonb,timestamptz)` at `20260930120001_p1_backend_remediation.sql:39`.
- `public.create_warranty_ticket_atomic(uuid,uuid,uuid,uuid,uuid,text,text,text)` at `20260930120001_p1_backend_remediation.sql:368`.
- `public.finalize_contract_signing_rpc(uuid,uuid,uuid,text,text)` at `20260929220003_commercial_security_hardening.sql:513`.
- `public.mutate_installation_atomic(uuid,uuid,uuid,text,text,text)` at `20261004210001_installation_rls_and_scheduling_authority.sql:244`.
- `public.process_payment_webhook_rpc(text,text,text,numeric,timestamptz,text,text)` at `20260929220003_commercial_security_hardening.sql:6`.
- `public.update_order_deposit_rpc(uuid,uuid,uuid,numeric,text)` at `20261002220001_commercial_exactly_once_and_recovery.sql:247`.

### payment_transactions

Current staging: 0 exact rows.

**Constraints**

- `fk_pt_matched_order`: `FOREIGN KEY (company_id, matched_order_id) REFERENCES orders(company_id, id) ON DELETE RESTRICT`
- `payment_transactions_amount_check`: `CHECK (amount > 0::numeric)`
- `payment_transactions_company_id_fkey`: `FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT`
- `payment_transactions_match_confidence_check`: `CHECK (match_confidence >= 0::numeric AND match_confidence <= 1::numeric)`
- `payment_transactions_pkey`: `PRIMARY KEY (id)`
- `payment_transactions_status_check`: `CHECK (status = ANY (ARRAY['PENDING'::text, 'MATCHED'::text, 'MANUAL_REVIEW_REQUIRED'::text, 'REJECTED'::text, 'RECONCILED'::text]))`
- `uq_pt_company_provider_ref`: `UNIQUE (company_id, provider, provider_ref)`

**Indexes**

- `idx_payment_transactions_matched`: `CREATE INDEX idx_payment_transactions_matched ON public.payment_transactions USING btree (company_id, matched_order_id) WHERE (matched_order_id IS NOT NULL)`
- `idx_payment_transactions_status`: `CREATE INDEX idx_payment_transactions_status ON public.payment_transactions USING btree (company_id, status, occurred_at DESC)`
- `payment_transactions_pkey`: `CREATE UNIQUE INDEX payment_transactions_pkey ON public.payment_transactions USING btree (id)`
- `uq_pt_company_provider_ref`: `CREATE UNIQUE INDEX uq_pt_company_provider_ref ON public.payment_transactions USING btree (company_id, provider, provider_ref)`

**Triggers**

- `trg_payment_facts_immutability`: `CREATE TRIGGER trg_payment_facts_immutability BEFORE UPDATE ON payment_transactions FOR EACH ROW EXECUTE FUNCTION enforce_payment_facts_immutability()`
- `trg_tenant_mutation_payments`: `CREATE TRIGGER trg_tenant_mutation_payments BEFORE UPDATE ON payment_transactions FOR EACH ROW EXECUTE FUNCTION prevent_tenant_mutation()`
- `trg_updated_at_payment_transactions`: `CREATE TRIGGER trg_updated_at_payment_transactions BEFORE UPDATE ON payment_transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`

**Policies**

- `payment_transactions_select_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=SELECT; with_check=None`

**Literal query consumers**

- `lib/server-auth/resource-access.ts:575` (library_or_configuration).
- `lib/server-auth/resource-access.ts:594` (library_or_configuration).

**Removed functions that reference this table before cleanup**

- `public.process_payment_webhook_rpc(text,text,text,numeric,timestamptz,text,text)` at `20260929220003_commercial_security_hardening.sql:6`.
- `public.update_order_deposit_rpc(uuid,uuid,uuid,numeric,text)` at `20261002220001_commercial_exactly_once_and_recovery.sql:247`.

### price_calculations

Current staging: 0 exact rows.

**Constraints**

- `chk_pc_need_info_amount`: `CHECK (status = 'NEED_INFO'::text AND amount IS NULL OR status <> 'NEED_INFO'::text)`
- `fk_orders_pricing`: `FOREIGN KEY (company_id, customer_id, price_calculation_id) REFERENCES price_calculations(company_id, customer_id, id) ON DELETE RESTRICT`
- `fk_pc_customer`: `FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id) ON DELETE RESTRICT`
- `fk_pc_policy_version`: `FOREIGN KEY (company_id, pricing_policy_id, policy_version) REFERENCES pricing_policies(company_id, id, version) ON DELETE RESTRICT`
- `fk_pc_survey`: `FOREIGN KEY (company_id, customer_id, survey_id) REFERENCES surveys(company_id, customer_id, id) ON DELETE RESTRICT`
- `price_calculations_amount_check`: `CHECK (amount IS NULL OR amount >= 0::numeric)`
- `price_calculations_company_id_fkey`: `FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT`
- `price_calculations_pkey`: `PRIMARY KEY (id)`
- `price_calculations_status_check`: `CHECK (status = ANY (ARRAY['CALCULATED'::text, 'NEED_INFO'::text, 'EXPIRED'::text, 'SUPERSEDED'::text]))`
- `uq_price_calculations_company_customer_id`: `UNIQUE (company_id, customer_id, id)`

**Indexes**

- `idx_price_calculations_customer`: `CREATE INDEX idx_price_calculations_customer ON public.price_calculations USING btree (company_id, customer_id, created_at DESC)`
- `price_calculations_pkey`: `CREATE UNIQUE INDEX price_calculations_pkey ON public.price_calculations USING btree (id)`
- `uq_price_calculations_company_customer_id`: `CREATE UNIQUE INDEX uq_price_calculations_company_customer_id ON public.price_calculations USING btree (company_id, customer_id, id)`

**Triggers**

- `trg_price_calculations_immutability`: `CREATE TRIGGER trg_price_calculations_immutability BEFORE DELETE OR UPDATE ON price_calculations FOR EACH ROW EXECUTE FUNCTION enforce_price_calculations_immutability()`

**Policies**

- `price_calculations_select_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=SELECT; with_check=None`
- `price_calculations_select_sale`: `roles=['authenticated']; using=has_company_role(company_id, 'SALE'::text); command=SELECT; with_check=None`

**Literal query consumers**

- None found; this does not cover clients outside the repository.

**Removed functions that reference this table before cleanup**

- `public.create_order_from_calculation_rpc(uuid,uuid,uuid,text,uuid)` at `20261002220001_commercial_exactly_once_and_recovery.sql:80`.
- `public.create_production_order_atomic(uuid,uuid,uuid,jsonb,jsonb,timestamptz)` at `20260930120001_p1_backend_remediation.sql:39`.
- `public.process_payment_webhook_rpc(text,text,text,numeric,timestamptz,text,text)` at `20260929220003_commercial_security_hardening.sql:6`.
- `public.save_price_calculation_rpc(uuid,uuid,uuid,uuid,text,jsonb,numeric,text,jsonb)` at `20260929220002_commercial_atomic_rpcs.sql:6`.
- `public.update_order_deposit_rpc(uuid,uuid,uuid,numeric,text)` at `20261002220001_commercial_exactly_once_and_recovery.sql:247`.

### pricing_policies

Current staging: 0 exact rows.

**Constraints**

- `fk_pc_policy_version`: `FOREIGN KEY (company_id, pricing_policy_id, policy_version) REFERENCES pricing_policies(company_id, id, version) ON DELETE RESTRICT`
- `pricing_policies_company_id_fkey`: `FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT`
- `pricing_policies_pkey`: `PRIMARY KEY (id)`
- `pricing_policies_status_check`: `CHECK (status = ANY (ARRAY['DRAFT'::text, 'ACTIVE'::text, 'SUPERSEDED'::text, 'RETIRED'::text]))`
- `uq_pricing_policies_company_id_version`: `UNIQUE (company_id, id, version)`
- `uq_pricing_policies_version`: `UNIQUE (company_id, version)`

**Indexes**

- `idx_pricing_policies_active`: `CREATE INDEX idx_pricing_policies_active ON public.pricing_policies USING btree (company_id, status) WHERE (status = 'ACTIVE'::text)`
- `pricing_policies_pkey`: `CREATE UNIQUE INDEX pricing_policies_pkey ON public.pricing_policies USING btree (id)`
- `uq_pricing_policies_company_id_version`: `CREATE UNIQUE INDEX uq_pricing_policies_company_id_version ON public.pricing_policies USING btree (company_id, id, version)`
- `uq_pricing_policies_version`: `CREATE UNIQUE INDEX uq_pricing_policies_version ON public.pricing_policies USING btree (company_id, version)`

**Triggers**

- `trg_pricing_policies_immutability`: `CREATE TRIGGER trg_pricing_policies_immutability BEFORE UPDATE ON pricing_policies FOR EACH ROW EXECUTE FUNCTION enforce_pricing_policies_immutability()`
- `trg_tenant_mutation_pricing`: `CREATE TRIGGER trg_tenant_mutation_pricing BEFORE UPDATE ON pricing_policies FOR EACH ROW EXECUTE FUNCTION prevent_tenant_mutation()`
- `trg_updated_at_pricing_policies`: `CREATE TRIGGER trg_updated_at_pricing_policies BEFORE UPDATE ON pricing_policies FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`

**Policies**

- `pricing_policies_insert_boss_admin`: `roles=['authenticated']; using=None; command=INSERT; with_check=has_company_role(company_id, 'BOSS_ADMIN'::text)`
- `pricing_policies_select_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=SELECT; with_check=None`
- `pricing_policies_update_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=UPDATE; with_check=has_company_role(company_id, 'BOSS_ADMIN'::text)`

**Literal query consumers**

- None found; this does not cover clients outside the repository.

**Removed functions that reference this table before cleanup**

- `public.create_production_order_atomic(uuid,uuid,uuid,jsonb,jsonb,timestamptz)` at `20260930120001_p1_backend_remediation.sql:39`.
- `public.process_payment_webhook_rpc(text,text,text,numeric,timestamptz,text,text)` at `20260929220003_commercial_security_hardening.sql:6`.
- `public.save_price_calculation_rpc(uuid,uuid,uuid,uuid,text,jsonb,numeric,text,jsonb)` at `20260929220002_commercial_atomic_rpcs.sql:6`.
- `public.update_order_deposit_rpc(uuid,uuid,uuid,numeric,text)` at `20261002220001_commercial_exactly_once_and_recovery.sql:247`.

### production_orders

Current staging: 0 exact rows.

**Constraints**

- `fk_production_orders_order`: `FOREIGN KEY (company_id, order_id) REFERENCES orders(company_id, id) ON DELETE RESTRICT`
- `production_orders_company_id_fkey`: `FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT`
- `production_orders_order_id_key`: `UNIQUE (order_id)`
- `production_orders_pkey`: `PRIMARY KEY (id)`
- `production_orders_qc_status_check`: `CHECK (qc_status = ANY (ARRAY['PENDING'::text, 'PASSED'::text, 'REWORK_REQUIRED'::text, 'REJECTED'::text]))`
- `production_orders_status_check`: `CHECK (status = ANY (ARRAY['PENDING_SPECS'::text, 'RELEASED_TO_FACTORY'::text, 'IN_PRODUCTION'::text, 'QC_IN_PROGRESS'::text, 'QC_PASSED'::text, 'QC_FAILED'::text, 'READY_FOR_DISPATCH'::text]))`

**Indexes**

- `idx_production_orders_status`: `CREATE INDEX idx_production_orders_status ON public.production_orders USING btree (company_id, status, deadline)`
- `production_orders_order_id_key`: `CREATE UNIQUE INDEX production_orders_order_id_key ON public.production_orders USING btree (order_id)`
- `production_orders_pkey`: `CREATE UNIQUE INDEX production_orders_pkey ON public.production_orders USING btree (id)`

**Triggers**

- `trg_tenant_mutation_production`: `CREATE TRIGGER trg_tenant_mutation_production BEFORE UPDATE ON production_orders FOR EACH ROW EXECUTE FUNCTION prevent_tenant_mutation()`
- `trg_updated_at_production_orders`: `CREATE TRIGGER trg_updated_at_production_orders BEFORE UPDATE ON production_orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`

**Policies**

- `production_orders_select_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=SELECT; with_check=None`
- `production_orders_select_sale`: `roles=['authenticated']; using=has_company_role(company_id, 'SALE'::text); command=SELECT; with_check=None`

**Literal query consumers**

- None found; this does not cover clients outside the repository.

**Removed functions that reference this table before cleanup**

- `public.create_installation_schedule_atomic(uuid,uuid,uuid,uuid,timestamptz,text,jsonb)` at `20261004210001_installation_rls_and_scheduling_authority.sql:67`.
- `public.create_production_order_atomic(uuid,uuid,uuid,jsonb,jsonb,timestamptz)` at `20260930120001_p1_backend_remediation.sql:39`.
- `public.update_production_progress_atomic(uuid,uuid,uuid,text)` at `20260928000001_operations_p0_hardening.sql:61`.

### survey_photo_operations

Current staging: 0 exact rows.

**Constraints**

- `survey_photo_operations_actor_id_fkey`: `FOREIGN KEY (actor_id) REFERENCES user_profiles(id)`
- `survey_photo_operations_appointment_id_fkey`: `FOREIGN KEY (appointment_id) REFERENCES appointments(id)`
- `survey_photo_operations_pkey`: `PRIMARY KEY (appointment_id)`

**Indexes**

- `survey_photo_operations_pkey`: `CREATE UNIQUE INDEX survey_photo_operations_pkey ON public.survey_photo_operations USING btree (appointment_id)`

**Triggers**

- None observed.

**Policies**

- None observed.

**Literal query consumers**

- None found; this does not cover clients outside the repository.

**Removed functions that reference this table before cleanup**

- `public.begin_survey_photo_operation(uuid,uuid)` at `20260924000001_survey_integrity_hardening.sql:26`.
- `public.complete_survey_atomic(uuid,uuid,jsonb)` at `20260924000001_survey_integrity_hardening.sql:127`.
- `public.end_survey_photo_operation(uuid,uuid)` at `20260924000001_survey_integrity_hardening.sql:71`.
- `public.guard_survey_appointment_write()` at `20260924000001_survey_integrity_hardening.sql:92`.

### surveys

Current staging: 0 exact rows.

**Constraints**

- `fk_pc_survey`: `FOREIGN KEY (company_id, customer_id, survey_id) REFERENCES surveys(company_id, customer_id, id) ON DELETE RESTRICT`
- `fk_surveys_appointment`: `FOREIGN KEY (company_id, customer_id, appointment_id) REFERENCES appointments(company_id, customer_id, id) ON DELETE RESTRICT`
- `fk_surveys_customer`: `FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id) ON DELETE RESTRICT`
- `surveys_company_id_fkey`: `FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT`
- `surveys_completed_by_fkey`: `FOREIGN KEY (completed_by) REFERENCES user_profiles(id) ON DELETE RESTRICT`
- `surveys_pkey`: `PRIMARY KEY (id)`
- `unique_survey_appointment`: `UNIQUE (appointment_id)`
- `uq_surveys_company_customer_id`: `UNIQUE (company_id, customer_id, id)`

**Indexes**

- `idx_surveys_company_completed_at`: `CREATE INDEX idx_surveys_company_completed_at ON public.surveys USING btree (company_id, completed_at)`
- `surveys_pkey`: `CREATE UNIQUE INDEX surveys_pkey ON public.surveys USING btree (id)`
- `unique_survey_appointment`: `CREATE UNIQUE INDEX unique_survey_appointment ON public.surveys USING btree (appointment_id)`
- `uq_surveys_company_customer_id`: `CREATE UNIQUE INDEX uq_surveys_company_customer_id ON public.surveys USING btree (company_id, customer_id, id)`

**Triggers**

- `trg_surveys_integrity`: `CREATE TRIGGER trg_surveys_integrity BEFORE INSERT OR UPDATE ON surveys FOR EACH ROW EXECUTE FUNCTION enforce_surveys_integrity()`
- `trg_tenant_mutation_surveys`: `CREATE TRIGGER trg_tenant_mutation_surveys BEFORE UPDATE ON surveys FOR EACH ROW EXECUTE FUNCTION prevent_tenant_mutation()`
- `trg_updated_at_surveys`: `CREATE TRIGGER trg_updated_at_surveys BEFORE UPDATE ON surveys FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`

**Policies**

- `surveys_select_assigned_technician`: `roles=['authenticated']; using=(has_company_role(company_id, 'TECHNICIAN'::text) AND is_assigned_technician(appointment_id)); command=SELECT; with_check=None`
- `surveys_select_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=SELECT; with_check=None`
- `surveys_select_sale`: `roles=['authenticated']; using=has_company_role(company_id, 'SALE'::text); command=SELECT; with_check=None`

**Literal query consumers**

- `lib/sensitive/signed-urls.ts:79` (library_or_configuration).
- `lib/server-auth/resource-access.ts:307` (library_or_configuration).
- `lib/server-auth/resource-access.ts:363` (library_or_configuration).

**Removed functions that reference this table before cleanup**

- `public.complete_survey_atomic(uuid,uuid,jsonb)` at `20260924000001_survey_integrity_hardening.sql:127`.
- `public.create_production_order_atomic(uuid,uuid,uuid,jsonb,jsonb,timestamptz)` at `20260930120001_p1_backend_remediation.sql:39`.
- `public.enforce_appointments_immutability()` at `20260914000001_initial_schema.sql:1043`.
- `public.guard_survey_appointment_write()` at `20260924000001_survey_integrity_hardening.sql:92`.
- `public.save_price_calculation_rpc(uuid,uuid,uuid,uuid,text,jsonb,numeric,text,jsonb)` at `20260929220002_commercial_atomic_rpcs.sql:6`.

### warranty_tickets

Current staging: 0 exact rows.

**Constraints**

- `fk_wt_customer`: `FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id) ON DELETE RESTRICT`
- `fk_wt_installation`: `FOREIGN KEY (company_id, customer_id, order_id, installation_id) REFERENCES installations(company_id, customer_id, order_id, id) ON DELETE RESTRICT`
- `fk_wt_order`: `FOREIGN KEY (company_id, customer_id, order_id) REFERENCES orders(company_id, customer_id, id) ON DELETE RESTRICT`
- `warranty_tickets_assigned_to_fkey`: `FOREIGN KEY (assigned_to) REFERENCES user_profiles(id) ON DELETE RESTRICT`
- `warranty_tickets_company_id_fkey`: `FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT`
- `warranty_tickets_pkey`: `PRIMARY KEY (id)`
- `warranty_tickets_status_check`: `CHECK (status = ANY (ARRAY['OPEN'::text, 'ASSIGNED'::text, 'IN_PROGRESS'::text, 'RESOLVED'::text, 'CLOSED'::text, 'REOPENED'::text, 'CANCELLED'::text, 'FAILED'::text]))`

**Indexes**

- `idx_warranty_tickets_assigned`: `CREATE INDEX idx_warranty_tickets_assigned ON public.warranty_tickets USING btree (company_id, assigned_to, status) WHERE (assigned_to IS NOT NULL)`
- `idx_warranty_tickets_status`: `CREATE INDEX idx_warranty_tickets_status ON public.warranty_tickets USING btree (company_id, status)`
- `warranty_tickets_pkey`: `CREATE UNIQUE INDEX warranty_tickets_pkey ON public.warranty_tickets USING btree (id)`

**Triggers**

- `trg_tenant_mutation_warranty`: `CREATE TRIGGER trg_tenant_mutation_warranty BEFORE UPDATE ON warranty_tickets FOR EACH ROW EXECUTE FUNCTION prevent_tenant_mutation()`
- `trg_updated_at_warranty_tickets`: `CREATE TRIGGER trg_updated_at_warranty_tickets BEFORE UPDATE ON warranty_tickets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`

**Policies**

- `warranty_tickets_insert_boss_admin`: `roles=['authenticated']; using=None; command=INSERT; with_check=has_company_role(company_id, 'BOSS_ADMIN'::text)`
- `warranty_tickets_insert_sale`: `roles=['authenticated']; using=None; command=INSERT; with_check=has_company_role(company_id, 'SALE'::text)`
- `warranty_tickets_select_assigned_technician`: `roles=['authenticated']; using=(has_company_role(company_id, 'TECHNICIAN'::text) AND (assigned_to = auth.uid())); command=SELECT; with_check=None`
- `warranty_tickets_select_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=SELECT; with_check=None`
- `warranty_tickets_select_sale`: `roles=['authenticated']; using=has_company_role(company_id, 'SALE'::text); command=SELECT; with_check=None`
- `warranty_tickets_update_boss_admin`: `roles=['authenticated']; using=has_company_role(company_id, 'BOSS_ADMIN'::text); command=UPDATE; with_check=has_company_role(company_id, 'BOSS_ADMIN'::text)`

**Literal query consumers**

- None found; this does not cover clients outside the repository.

**Removed functions that reference this table before cleanup**

- `public.create_warranty_ticket_atomic(uuid,uuid,uuid,uuid,uuid,text,text,text)` at `20260930120001_p1_backend_remediation.sql:368`.
- `public.update_warranty_status_atomic(uuid,uuid,uuid,text,text,text,uuid,text)` at `20260928000001_operations_p0_hardening.sql:160`.

## Dynamic function targets

Each name selects **all overloads** in public. The static canonical timeline has one matching overload per name at the removal boundary; live staging currently has 22 of them. A new externally created overload would also be selected, so the live set must be allowlisted before execution.

| Name / pre-removal signature | Live now | Last definition | Table references | Database function callers before removal | Repository RPC consumers |
| --- | --- | --- | --- | --- | --- |
| `public.accept_installation_appointment_atomic(uuid,uuid,uuid)` | absent; pending | `20261004180001_installation_product_journey.sql:157` | appointments | none textually found | none found |
| `public.begin_survey_photo_operation(uuid,uuid)` | present | `20260924000001_survey_integrity_hardening.sql:26` | appointments, survey_photo_operations | none textually found | none found |
| `public.claim_contract_generation_rpc(uuid,uuid,bool)` | absent; pending | `20260929220003_commercial_security_hardening.sql:350` | contracts, orders | none textually found | none found |
| `public.complete_installation_atomic(uuid,uuid,uuid,jsonb,text)` | present | `20261004180001_installation_product_journey.sql:370` | appointments, installations, operations_outbox, orders | none textually found | none found |
| `public.complete_survey_atomic(uuid,uuid,jsonb)` | present | `20260924000001_survey_integrity_hardening.sql:127` | appointments, survey_photo_operations, surveys | none textually found | none found |
| `public.create_installation_schedule_atomic(uuid,uuid,uuid,uuid,timestamptz,text,jsonb)` | absent; pending | `20261004210001_installation_rls_and_scheduling_authority.sql:67` | appointments, installations, orders, production_orders | none textually found | none found |
| `public.create_order_from_calculation_rpc(uuid,uuid,uuid,text,uuid)` | absent; pending | `20261002220001_commercial_exactly_once_and_recovery.sql:80` | finance_summaries, orders, price_calculations | none textually found | none found |
| `public.create_production_order_atomic(uuid,uuid,uuid,jsonb,jsonb,timestamptz)` | present | `20260930120001_p1_backend_remediation.sql:39` | contracts, orders, price_calculations, pricing_policies, production_orders, surveys | none textually found | none found |
| `public.create_warranty_ticket_atomic(uuid,uuid,uuid,uuid,uuid,text,text,text)` | absent; pending | `20260930120001_p1_backend_remediation.sql:368` | installations, orders, warranty_tickets | none textually found | none found |
| `public.end_survey_photo_operation(uuid,uuid)` | present | `20260924000001_survey_integrity_hardening.sql:71` | appointments, survey_photo_operations | none textually found | none found |
| `public.enforce_appointments_immutability()` | present | `20260914000001_initial_schema.sql:1043` | installations, surveys | none textually found | none found |
| `public.enforce_contracts_immutability()` | present | `20260914000001_initial_schema.sql:1171` |  | none textually found | none found |
| `public.enforce_installations_integrity()` | present | `20260914000001_initial_schema.sql:1197` | appointments | none textually found | none found |
| `public.enforce_orders_immutability()` | present | `20260914000001_initial_schema.sql:1133` |  | none textually found | none found |
| `public.enforce_payment_facts_immutability()` | present | `20260914000001_initial_schema.sql:1151` |  | none textually found | none found |
| `public.enforce_price_calculations_immutability()` | present | `20260914000001_initial_schema.sql:1120` |  | none textually found | none found |
| `public.enforce_pricing_policies_immutability()` | present | `20260914000001_initial_schema.sql:1096` |  | none textually found | none found |
| `public.enforce_surveys_integrity()` | present | `20260914000001_initial_schema.sql:1065` | appointments | none textually found | none found |
| `public.finalize_contract_signing_rpc(uuid,uuid,uuid,text,text)` | absent; pending | `20260929220003_commercial_security_hardening.sql:513` | contracts, orders | none textually found | none found |
| `public.finalize_generated_contract_rpc(uuid,uuid,text)` | absent; pending | `20260929220003_commercial_security_hardening.sql:467` | contracts | none textually found | none found |
| `public.generate_order_code()` | present | `20260914000001_initial_schema.sql:95` |  | public.create_order_from_calculation_rpc(uuid,uuid,uuid,text,uuid) | none found |
| `public.guard_survey_appointment_write()` | present | `20260924000001_survey_integrity_hardening.sql:92` | survey_photo_operations, surveys | none textually found | none found |
| `public.is_assigned_technician(uuid)` | present | `20260915000001_rls_foundation.sql:66` | appointments | none textually found | none found |
| `public.mutate_installation_atomic(uuid,uuid,uuid,text,text,text)` | present | `20261004210001_installation_rls_and_scheduling_authority.sql:244` | appointments, installations, orders | none textually found | none found |
| `public.operations_actor(uuid,uuid,text[])` | present | `20260928000001_operations_p0_hardening.sql:24` |  | public.record_quality_check_atomic(uuid,uuid,text,uuid,text), public.create_production_order_atomic(uuid,uuid,uuid,jsonb,jsonb,timestamptz), public.update_production_progress_atomic(uuid,uuid,uuid,text), public.mutate_installation_atomic(uuid,uuid,uuid,text,text,text), public.complete_installation_atomic(uuid,uuid,uuid,jsonb,text), public.update_warranty_status_atomic(uuid,uuid,uuid,text,text,text,uuid,text), public.create_warranty_ticket_atomic(uuid,uuid,uuid,uuid,uuid,text,text,text), public.create_installation_schedule_atomic(uuid,uuid,uuid,uuid,timestamptz,text,jsonb), public.accept_installation_appointment_atomic(uuid,uuid,uuid), public.start_installation_work_atomic(uuid,uuid,uuid) | none found |
| `public.operations_audit(uuid,uuid,text,text,uuid,jsonb)` | present | `20260928000001_operations_p0_hardening.sql:34` |  | public.record_quality_check_atomic(uuid,uuid,text,uuid,text), public.create_production_order_atomic(uuid,uuid,uuid,jsonb,jsonb,timestamptz), public.update_production_progress_atomic(uuid,uuid,uuid,text), public.mutate_installation_atomic(uuid,uuid,uuid,text,text,text), public.complete_installation_atomic(uuid,uuid,uuid,jsonb,text), public.update_warranty_status_atomic(uuid,uuid,uuid,text,text,text,uuid,text), public.create_installation_schedule_atomic(uuid,uuid,uuid,uuid,timestamptz,text,jsonb), public.accept_installation_appointment_atomic(uuid,uuid,uuid), public.start_installation_work_atomic(uuid,uuid,uuid) | none found |
| `public.operations_evidence_ref(uuid,uuid,text,text)` | present | `20260928000001_operations_p0_hardening.sql:39` |  | public.mutate_installation_atomic(uuid,uuid,uuid,text,text,text), public.complete_installation_atomic(uuid,uuid,uuid,jsonb,text) | none found |
| `public.process_payment_webhook_rpc(text,text,text,numeric,timestamptz,text,text)` | absent; pending | `20260929220003_commercial_security_hardening.sql:6` | company_bank_accounts, finance_summaries, orders, payment_transactions, price_calculations, pricing_policies | none textually found | none found |
| `public.save_price_calculation_rpc(uuid,uuid,uuid,uuid,text,jsonb,numeric,text,jsonb)` | absent; pending | `20260929220002_commercial_atomic_rpcs.sql:6` | price_calculations, pricing_policies, surveys | none textually found | none found |
| `public.start_installation_work_atomic(uuid,uuid,uuid)` | absent; pending | `20261004180001_installation_product_journey.sql:227` | appointments, installations | none textually found | none found |
| `public.update_order_deposit_rpc(uuid,uuid,uuid,numeric,text)` | absent; pending | `20261002220001_commercial_exactly_once_and_recovery.sql:247` | finance_summaries, orders, payment_transactions, price_calculations, pricing_policies | none textually found | none found |
| `public.update_production_progress_atomic(uuid,uuid,uuid,text)` | present | `20260928000001_operations_p0_hardening.sql:61` | production_orders | none textually found | none found |
| `public.update_warranty_status_atomic(uuid,uuid,uuid,text,text,text,uuid,text)` | present | `20260928000001_operations_p0_hardening.sql:160` | warranty_tickets | none textually found | none found |
