-- ==============================================================================
-- Migration: Create Pricing, Payment, Contract, Order tables
-- ==============================================================================

-- [DELETED]: The content of this migration was deleted during code review.
-- Reason: The tables `orders`, `contracts`, `payment_transactions`, 
-- `price_calculations`, and `pricing_policies` already exist in the 
-- Foundation schema (`20260914000001_initial_schema.sql`). 
-- Additionally, the RLS policies granting self-expanded access for 'SALE'
-- role have been reverted to strictly adhere to the Foundation RLS guidelines.
