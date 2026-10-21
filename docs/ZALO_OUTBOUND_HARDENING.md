# Zalo Personal outbound recording integrity

An outbound recording previously could attach to a same-company request without proving a valid claim, device, direction, or call start window. The Mac agent also consulted a global pending request at recording completion, losing valid context on long calls and allowing ambiguous names to associate with another call. Concurrent recording reservations could deadlock while upgrading a shared device lock.

Additive migration `20261020220005_zalo_outbound_recording_hardening.sql` validates the active request actor, claiming device, target device, role, direction, call start window, request state, and one-call use before issuing a lease or returning an upload in progress. Finalization repeats those checks for reservations made by older versions. Exact completed replays remain idempotent. Device locks precede call and request locks, avoiding the previous lock upgrade cycle.

Claiming is allowed once. Status transitions require opening Zalo and verifying the contact before a trigger or detection. Detection may precede the trigger acknowledgment; a late acknowledgment retains the detected state. Activation expiry prevents a new call, while a recording started within the request window can finish after expiry. Only trusted recording finalization can mark the request completed. Recording readiness, exact customer attachment, request completion, and the audit event share one database transaction.

A Boss may explicitly target another active staff device in the same company. Sale users may use their own or shared devices. Shared outbound recordings inherit the validated request actor; standalone shared inbound recordings keep unknown staff ownership. Confirmed display-name mappings are scoped to the selected device's Zalo account.

Browser actions, polling responses, and authenticated column grants omit the dialing phone. The claimed device receives it through the device-authenticated server route. Status reads enforce both company and Sale ownership. Inbound identity remains `DISPLAY_NAME_ONLY`; this change adds no transcription or Stringee behavior.

The Mac agent binds context to the active recording once, using the normalized expected display name. Inbound direction or a conflicting observed contact invalidates that association. Unknown contacts can become identifiable later, and a bound context survives the pending request timeout. Session state is synchronized, and overlapping execution is rejected. Opening and contact verification require successful server acknowledgments before dialing. Status requests retry transient failures at most twice; the physical dial is never retried.

## Validation boundary

Run `npm run test:zalo-recordings`, `npm run test:zalo-recordings:db`, `bash local-agent/tests/run.sh`, `npm run test:integration-gate`, and `npm run build`. Tests use synthetic audio and controlled local fixtures. Database concurrency must be verified against real PostgreSQL, not inferred from PGlite. Production Swift compilation does not establish a live Zalo call or installed-agent rollout.

## Rollout

Apply new migrations `220001`, `220003`, `220004`, and `220005` after the existing outbound-request and heartbeat migrations. Verify the database before merging application changes because Render main may auto-deploy. No old Foundation migration is modified. This run authorizes a feature PR, not a production migration, merge, deployment, or Mac agent installation.
