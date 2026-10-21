-- Restores AI durable dispatch statuses lost in 20261012113001 while preserving
-- the Facebook browser-outbox reconciliation contract. No rows are rewritten.
ALTER TABLE public.outbound_deliveries
  DROP CONSTRAINT IF EXISTS outbound_deliveries_delivery_status_check;

ALTER TABLE public.outbound_deliveries
  ADD CONSTRAINT outbound_deliveries_delivery_status_check
  CHECK (delivery_status IN (
    'PENDING', 'PENDING_DISPATCH', 'QUEUED', 'SENT', 'DELIVERED', 'FAILED',
    'DISPATCHING', 'PROVIDER_SENT_PENDING_FINALIZE', 'UNCERTAIN', 'PROVIDER_UNCERTAIN',
    'PROCESSING', 'RETRY', 'RECONCILE_REQUIRED'
  ));

COMMENT ON CONSTRAINT outbound_deliveries_delivery_status_check ON public.outbound_deliveries
  IS 'Closed union of durable AI dispatch, finalization, and browser-outbox reconciliation statuses.';
