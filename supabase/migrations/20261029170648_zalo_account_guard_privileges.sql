-- The conversation guard is an internal trigger that verifies private account
-- metadata during service-role updates to public conversations. Keep its private
-- lookup under the owning role without granting access to credential storage.
ALTER FUNCTION private.zalo_account_conversation_guard() SECURITY DEFINER;
REVOKE ALL ON FUNCTION private.zalo_account_conversation_guard() FROM PUBLIC, anon, authenticated, service_role;
