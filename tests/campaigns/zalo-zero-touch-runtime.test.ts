import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  "supabase/migrations/20261025051000_zalo_personal_zero_touch_customer_sync.sql",
  "utf8",
);

test("zero-touch sync never uses display name as an identity key", () => {
  assert.match(migration, /display name is never a join key/i);
  assert.match(migration, /does NOT reuse any customer merely because the display name matches/i);
  assert.doesNotMatch(migration, /lower\([^\n]*name[^\n]*\)\s*=\s*lower/i);
});

test("zero-touch sync materializes Customer 360 plus identity without a synthetic Inbox conversation", () => {
  assert.match(migration, /INSERT INTO public\.customers/);
  assert.match(migration, /INSERT INTO public\.identities/);
  assert.doesNotMatch(migration, /INSERT INTO public\.conversations/);
  assert.match(migration, /a real conversation is optional/i);
  assert.match(migration, /conversation_id',conv\.id/);
});

test("official Zalo routes remain fail-closed", () => {
  assert.match(migration, /zero_touch_blocked/);
  assert.match(migration, /route_conflict/);
  assert.match(migration, /CONTINUE;/);
});
