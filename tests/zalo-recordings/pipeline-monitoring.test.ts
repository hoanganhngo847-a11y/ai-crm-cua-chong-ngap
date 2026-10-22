import assert from 'node:assert/strict';
import {
  aggregatePipelineStatuses,
  safePipelineErrorCode,
} from '../../features/zalo-monitoring/dashboard';

let passed = 0;
function pass(name: string) {
  passed += 1;
  console.log(`[PASS] ${name}`);
}

function main() {
  const aggregate = aggregatePipelineStatuses([
    { recording_status: 'READY', transcript_status: 'COMPLETED', summary_status: 'COMPLETED' },
    { recording_status: 'READY', transcript_status: 'FAILED', summary_status: 'NOT_STARTED' },
    { recording_status: 'UPLOADING', transcript_status: 'PROCESSING', summary_status: 'PENDING' },
    { recording_status: 'READY', transcript_status: null, summary_status: 'FAILED' },
  ]);

  assert.equal(aggregate.recordingReady, 3);
  assert.deepEqual(aggregate.transcription, {
    NOT_STARTED: 1,
    PENDING: 0,
    PROCESSING: 1,
    COMPLETED: 1,
    FAILED: 1,
  });
  assert.deepEqual(aggregate.summary, {
    NOT_STARTED: 1,
    PENDING: 1,
    PROCESSING: 0,
    COMPLETED: 1,
    FAILED: 1,
  });
  pass('pipeline status aggregation is deterministic');

  assert.equal(safePipelineErrorCode('GEMINI_RATE_LIMITED'), 'GEMINI_RATE_LIMITED');
  assert.equal(safePipelineErrorCode('SUMMARY_PROVIDER_TIMEOUT'), 'SUMMARY_PROVIDER_TIMEOUT');
  assert.equal(safePipelineErrorCode('  GEMINI_AUTH_ERROR  '), 'GEMINI_AUTH_ERROR');
  pass('canonical error codes are preserved');

  assert.equal(
    safePipelineErrorCode('429 request failed for key AIzaSecretValue and /Users/example/private.json'),
    'PROVIDER_ERROR'
  );
  assert.equal(safePipelineErrorCode('Bearer secret-token'), 'PROVIDER_ERROR');
  assert.equal(safePipelineErrorCode(null), null);
  pass('raw provider details and secret-like error messages are not exposed');

  console.log(`ALL ${passed} PIPELINE MONITORING TESTS PASSED`);
}

main();
